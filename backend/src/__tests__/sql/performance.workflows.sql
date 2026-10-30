-- C3: lists and facets reuse one verdict per actor-scoped workflow candidate.
begin;
create temporary table workflow_actors(uid text,email text);
create temporary table workflow_workspaces(workspace text);
create temporary sequence workflow_calls minvalue 0 start 0;
do $$
declare actor uuid:=gen_random_uuid(); other_actor uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); foreign_org uuid:=gen_random_uuid(); wid uuid;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test'),(other_actor,other_actor||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Visible org',actor),(foreign_org,'Unrelated org',other_actor);
  insert into public.org_members(org_id,user_id,role) values(org,actor,'owner'),(org,other_actor,'member'),(foreign_org,other_actor,'owner');
  insert into workflow_actors values(actor::text,actor||'@example.test'),(other_actor::text,other_actor||'@example.test'),('invalid',null);
  insert into workflow_workspaces values(null),('personal'),(org::text),(foreign_org::text);
  insert into public.workflows(user_id,org_id,title,type,visibility) values(actor,null,'Owned','assistant','private'),(other_actor,org,'Public','assistant','organization'),(other_actor,org,'Hidden','assistant','private');
  insert into public.workflows(user_id,title,type) values(other_actor,'Direct shared','assistant') returning id into wid;
  insert into public.workflow_shares(workflow_id,shared_with_email,shared_by_user_id,role) values(wid,actor||'@example.test',other_actor,'viewer');
  insert into public.workflows(user_id,title,type) values(other_actor,'Archived shared','assistant') returning id into wid;
  insert into public.workflow_shares(workflow_id,shared_with_email,shared_by_user_id,role) values(wid,actor||'@example.test',other_actor,'viewer');
  update public.workflows set archived_at=now() where id=wid;
  insert into public.workflows(user_id,org_id,title,type) values(other_actor,org,'Opened','assistant') returning id into wid;
  perform public.open_org_private_content(org,actor,'workflow',wid);
  insert into public.workflows(user_id,org_id,title,type) select other_actor,foreign_org,'Unrelated '||n,'assistant' from generate_series(1,1000) n;
  perform set_config('mike.test_workflow_actor',actor::text,true);
end;
$$;
do $$
declare a record; w record; expected uuid[]; actual uuid[];
begin
  for a in select * from workflow_actors loop
    for w in select * from workflow_workspaces loop
      select array_agg(id order by id) into expected from public.workflows item where public.workspace_matches(w.workspace,item.org_id)
        and public.workflow_access_role(item.id,item.user_id,item.org_id,a.uid,a.email) is not null;
      select array_agg(id order by id) into actual from public.get_workflows_overview(a.uid,a.email,null,'all',2000,0,null,'created','desc',null,null,null,w.workspace);
      assert actual is not distinct from expected,'workflow overview authorization parity';
      select array_agg(id order by id) into actual from public.get_workflow_ids_overview(a.uid,a.email,null,'all',null,null,null,null,2000,0,w.workspace);
      assert actual is not distinct from expected,'workflow ids parity';
    end loop;
    select array_agg(id order by id) into expected from public.workflows item where public.workflow_access_role(item.id,item.user_id,item.org_id,a.uid,a.email) is not null;
    select array_agg(id order by id) into actual from public.get_workflows_overview(a.uid,a.email,null);
    assert actual is not distinct from expected,'legacy workflow list parity';
  end loop;
end;
$$;
alter function public.workflow_access_role(uuid,uuid,uuid,text,text) rename to workflow_role_oracle;
create function public.workflow_access_role(p_workflow_id uuid,p_workflow_user_id uuid,p_org_id uuid,p_user_id text,p_user_email text)
returns text language plpgsql set search_path=public as $$
begin perform nextval('pg_temp.workflow_calls');return public.workflow_role_oracle(p_workflow_id,p_workflow_user_id,p_org_id,p_user_id,p_user_email);end;
$$;
do $$
declare actor text:=current_setting('mike.test_workflow_actor'); candidates integer;
begin
  select count(*) into candidates from public.workflows w where w.user_id=actor::uuid
    or w.org_id in(select org_id from public.org_members where user_id=actor::uuid)
    or w.id in(select workflow_id from public.workflow_shares where lower(shared_with_email)=actor||'@example.test');
  perform * from public.get_workflows_overview(actor,actor||'@example.test',null);
  assert (select last_value+1=candidates from pg_temp.workflow_calls),'one workflow verdict per candidate, not three per result or one per platform row';
end;
$$;
rollback;
