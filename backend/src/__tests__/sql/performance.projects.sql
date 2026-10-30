-- C1: list candidates must preserve the complete authorization ladder and
-- avoid evaluating that ladder for unrelated tenants' projects.
begin;
create temporary table project_test_actors(uid text,email text);
create temporary table project_test_workspaces(workspace text);
create temporary sequence project_verdict_calls minvalue 0 start 0;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  org uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid(); pid uuid;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test'),(outsider,outsider||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Our org',owner_id),(other_org,'Other org',outsider);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member'),(other_org,outsider,'owner');
  insert into project_test_actors values(owner_id::text,owner_id||'@example.test'),(member_id::text,member_id||'@example.test'),(outsider::text,outsider||'@example.test'),('invalid',null);
  insert into project_test_workspaces values(null),('personal'),(org::text),(other_org::text);
  insert into public.projects(user_id,org_id,name,visibility) values
    (owner_id,null,'Owned','private'),(member_id,org,'Public','organization'),(member_id,org,'Hidden','private');
  insert into public.projects(user_id,name) values(outsider,'Direct') returning id into pid;
  insert into public.project_access_grants(project_id,email,role,created_by) values(pid,owner_id||'@example.test','viewer',outsider);
  insert into public.projects(user_id,org_id,name,visibility) values(owner_id,org,'Denied','organization') returning id into pid;
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values(pid,org,member_id,'deny');
  insert into public.projects(user_id,org_id,name) values(member_id,org,'Opened') returning id into pid;
  perform public.open_org_private_content(org,owner_id,'project',pid);
  insert into public.projects(user_id,org_id,name,archived_at) values(owner_id,org,'Archived',now());
  insert into public.projects(user_id,org_id,name) select outsider,other_org,'Unrelated '||n from generate_series(1,1000) n;
  perform set_config('mike.test_project_actor',owner_id::text,true);
end;
$$;
create temporary table project_expected as
select a.uid,p.id,p.org_id,public.project_access_role(p.id,p.user_id,p.org_id,a.uid,a.email) role
from public.projects p cross join project_test_actors a;
do $$
declare a record; w record; actual jsonb; expected jsonb; actual_ids uuid[]; expected_ids uuid[];
begin
  for a in select * from project_test_actors loop
    for w in select * from project_test_workspaces loop
      select jsonb_agg(jsonb_build_array(id,role) order by id) into expected from project_expected
        where uid=a.uid and role is not null and public.workspace_matches(w.workspace,org_id);
      select jsonb_agg(jsonb_build_array(id,access_role) order by id) into actual
        from public.get_projects_overview(a.uid,a.email,'all',2000,0,null,'created','desc',null,null,w.workspace);
      assert actual is not distinct from expected,'project overview verdict parity';
      select array_agg(id order by id) into expected_ids from project_expected
        where uid=a.uid and role is not null and public.workspace_matches(w.workspace,org_id);
      select array_agg(id order by id) into actual_ids from public.get_project_ids_overview(a.uid,a.email,'all',null,null,null,2000,0,w.workspace);
      assert actual_ids is not distinct from expected_ids,'project ids parity';
      select array_agg(id order by id) into actual_ids from public.get_project_summaries(a.uid,a.email,2000,0,w.workspace);
      assert actual_ids is not distinct from expected_ids,'project sidebar parity';
    end loop;
    select jsonb_agg(jsonb_build_array(id,access_role) order by id) into actual from public.get_projects_overview(a.uid,a.email);
    select jsonb_agg(jsonb_build_array(id,role) order by id) into expected from project_expected where uid=a.uid and role is not null;
    assert actual is not distinct from expected,'legacy project overview parity';
  end loop;
end;
$$;
alter function public.project_access_role(uuid,uuid,uuid,text,text) rename to project_verdict_oracle;
create function public.project_access_role(p_project_id uuid,p_project_user_id uuid,p_org_id uuid,p_user_id text,p_user_email text)
returns text language plpgsql set search_path=public as $$
begin
  perform nextval('pg_temp.project_verdict_calls');
  return public.project_verdict_oracle(p_project_id,p_project_user_id,p_org_id,p_user_id,p_user_email);
end;
$$;
do $$
declare actor text:=current_setting('mike.test_project_actor'); calls bigint; candidates bigint;
begin
  select count(*) into candidates from public.projects p where p.user_id=actor::uuid
    or p.org_id in (select org_id from public.org_members where user_id=actor::uuid)
    or p.id in (select project_id from public.project_access_grants where email=actor||'@example.test');
  perform * from public.get_projects_overview(actor,actor||'@example.test');
  select last_value+1 into calls from pg_temp.project_verdict_calls;
  assert calls=candidates,'list must evaluate one verdict per candidate, not per platform row or twice per result';
end;
$$;
rollback;
