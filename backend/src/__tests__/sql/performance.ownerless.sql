-- M-S4: the ownerless-item list is one set-based query with exactly the
-- per-item ownerless verdicts' answer.
begin;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); gone uuid:=gen_random_uuid();
  org uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid(); pid uuid; wid uuid;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test'),(gone,gone||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Ownerless',owner_id),(other_org,'Elsewhere',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member'),(other_org,owner_id,'owner'),(other_org,gone,'member');
  -- Creator gone (null, or a member only of another org), still a member,
  -- rescued by an owner override, archived, public, and an editor override.
  insert into public.projects(org_id,user_id,name,visibility) values(org,null,'No creator','private'),(org,gone,'Creator elsewhere','private'),
    (org,member_id,'Creator here','private'),(org,null,'Public','organization');
  insert into public.projects(org_id,user_id,name,visibility) values(org,null,'Rescued','private') returning id into pid;
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values(pid,org,member_id,'owner');
  insert into public.projects(org_id,user_id,name,visibility) values(org,null,'Editor only','private') returning id into pid;
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values(pid,org,member_id,'editor');
  insert into public.projects(org_id,user_id,name,visibility,archived_at) values(org,null,'Archived','private',now());
  insert into public.projects(org_id,user_id,name,visibility) select org,null,'Bulk '||n,'private' from generate_series(1,200) n;
  insert into public.workflows(org_id,user_id,title,type,visibility) values(org,null,'No creator','assistant','private'),
    (org,member_id,'Creator here','assistant','private'),(org,gone,'Creator elsewhere','assistant','private');
  insert into public.workflows(org_id,user_id,title,type,visibility) values(org,null,'Rescued','assistant','private') returning id into wid;
  insert into public.workflow_org_access_overrides(workflow_id,org_id,user_id,role) values(wid,org,member_id,'owner');
  insert into public.workflows(org_id,user_id,title,type,visibility,archived_at) values(org,null,'Archived','assistant','private',now());
  perform set_config('mike.test_ownerless_orgs',array[org,other_org]::text,true);
end;
$$;
create temporary table ownerless_expected as
  select 'project'::text kind,p.id item_id from public.projects p
    where p.org_id=any(current_setting('mike.test_ownerless_orgs')::uuid[]) and p.visibility<>'organization'
      and public.project_is_ownerless(p.id,p.user_id,p.org_id)
  union all select 'workflow',w.id from public.workflows w
    where w.org_id=any(current_setting('mike.test_ownerless_orgs')::uuid[]) and w.visibility<>'organization'
      and public.workflow_is_ownerless(w.id,w.user_id,w.org_id);
-- From here on a per-item verdict call is a failure.
create or replace function public.project_is_ownerless(p_project_id uuid,p_project_user_id uuid,p_org_id uuid)
returns boolean language plpgsql stable set search_path=public as $$
begin raise exception 'ownerless list called project_is_ownerless per item'; end;
$$;
create or replace function public.workflow_is_ownerless(p_workflow_id uuid,p_workflow_user_id uuid,p_org_id uuid)
returns boolean language plpgsql stable set search_path=public as $$
begin raise exception 'ownerless list called workflow_is_ownerless per item'; end;
$$;
do $$
declare actual jsonb; expected jsonb;
begin
  select jsonb_agg(jsonb_build_array(kind,item_id) order by kind,item_id) into expected from ownerless_expected;
  select jsonb_agg(jsonb_build_array(kind,item_id) order by kind,item_id) into actual
    from public.ownerless_org_item_ids(current_setting('mike.test_ownerless_orgs')::uuid[]);
  assert jsonb_array_length(expected)=205,format('fixture: %s ownerless items',jsonb_array_length(expected));
  assert actual=expected,'ownerless items changed';
end;
$$;
rollback;
