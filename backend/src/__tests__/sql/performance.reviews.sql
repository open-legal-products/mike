-- C2: reviews inherit one authoritative parent verdict and use indexed candidates.
begin;
create temporary table review_actors(uid text,email text);
create temporary table review_scopes(project_id text);
create temporary sequence review_project_calls minvalue 0 start 0;
do $$
declare actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); project uuid:=gen_random_uuid();
  foreign_project uuid:=gen_random_uuid(); direct_review uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); opened uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test'),(other_actor,other_actor||'@example.test');
  insert into review_actors values(actor::text,actor||'@example.test'),(other_actor::text,other_actor||'@example.test'),('bad-id',null);
  insert into public.organizations(id,name,created_by) values(org,'Review org',actor);
  insert into public.org_members(org_id,user_id,role) values(org,actor,'owner'),(org,other_actor,'member');
  insert into public.projects(id,user_id,name) values(project,actor,'Visible parent'),(foreign_project,other_actor,'Hidden parent');
  insert into public.tabular_reviews(project_id,user_id,title) select project,other_actor,'Child '||n from generate_series(1,100) n;
  insert into public.tabular_reviews(project_id,user_id,title) values(foreign_project,actor,'Owned child cannot bypass hidden parent');
  insert into public.tabular_reviews(id,user_id,title) values(direct_review,other_actor,'Directly shared');
  insert into public.tabular_review_access_grants(tabular_review_id,email,role,created_by) values(direct_review,actor||'@example.test','viewer',other_actor);
  insert into public.tabular_reviews(id,org_id,user_id,title) values(opened,org,other_actor,'Opened private');
  perform public.open_org_private_content(org,actor,'tabular_review',opened);
  insert into public.tabular_reviews(user_id,title) select other_actor,'Unrelated '||n from generate_series(1,1000) n;
  insert into review_scopes values(null),(project::text),(foreign_project::text),('invalid');
  perform set_config('mike.test_review_actor',actor::text,true);perform set_config('mike.test_review_project',project::text,true);
end;
$$;
do $$
declare a record; s record; expected jsonb; actual jsonb; ids uuid[]; expected_ids uuid[];
begin
  for a in select * from review_actors loop
    for s in select * from review_scopes loop
      select jsonb_agg(jsonb_build_array(id,role) order by id),array_agg(id order by id) into expected,expected_ids from (
        select r.id,public.review_access_role(r.id,r.user_id,r.project_id,r.org_id,a.uid,a.email) role
        from public.tabular_reviews r where (s.project_id is null or r.project_id::text=s.project_id)
          and (s.project_id is null or exists(select 1 from public.projects p where p.id::text=s.project_id and public.project_access_role(p.id,p.user_id,p.org_id,a.uid,a.email) is not null))
      ) x where role is not null;
      select jsonb_agg(jsonb_build_array(id,access_role) order by id) into actual
        from public.get_tabular_reviews_overview(a.uid,a.email,s.project_id,'all',2000,0,null,'created','desc',null,null);
      assert actual is not distinct from expected,'review list parity';
      select array_agg(id order by id) into ids from public.get_tabular_review_ids_overview(a.uid,a.email,s.project_id,'all',null,2000,0,null,null);
      assert ids is not distinct from expected_ids,'review ids parity';
    end loop;
  end loop;
end;
$$;
alter function public.project_access_role(uuid,uuid,uuid,text,text) rename to review_parent_oracle;
create function public.project_access_role(p_project_id uuid,p_project_user_id uuid,p_org_id uuid,p_user_id text,p_user_email text)
returns text language plpgsql set search_path=public as $$
begin perform nextval('pg_temp.review_project_calls');return public.review_parent_oracle(p_project_id,p_project_user_id,p_org_id,p_user_id,p_user_email);end;
$$;
do $$
declare actor text:=current_setting('mike.test_review_actor'); project text:=current_setting('mike.test_review_project');
begin
  assert (select count(*)=100 from public.get_tabular_reviews_overview(actor,actor||'@example.test',project,'all',200,0,null,'created','desc',null,null)), 'all children remain visible';
  assert (select last_value=0 and is_called from pg_temp.review_project_calls), 'one requested project must be checked once, not once per review';
end;
$$;
rollback;
