-- H8: moving directory authorization into SQL must retain the complete
-- organization permission ladder, including denial and private isolation.
begin;
create function pg_temp.directory_has(actor uuid,item uuid,workspace text default null)
returns boolean language sql as $$
  select exists(select 1 from jsonb_array_elements(public.search_project_directory(
    actor::text,actor||'@example.test','Directory permission',100,0,workspace)) p where p->>'id'=item::text);
$$;
do $$
declare owner_id uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid();
  creator uuid:=gen_random_uuid(); departed uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  org uuid:=gen_random_uuid(); foreign_org uuid:=gen_random_uuid();
  public_item uuid:=gen_random_uuid(); private_item uuid:=gen_random_uuid(); opened_item uuid:=gen_random_uuid();
  ownerless uuid:=gen_random_uuid(); departed_item uuid:=gen_random_uuid(); stale_deny uuid:=gen_random_uuid();
  foreign_item uuid:=gen_random_uuid(); personal_item uuid:=gen_random_uuid();
  actor uuid; scope text; expected uuid[]; actual uuid[];
begin
  foreach actor in array array[owner_id,admin_id,member_id,creator,departed,outsider] loop
    insert into auth.users(id,email) values(actor,actor||'@example.test');
  end loop;
  insert into public.organizations(id,name,created_by) values(org,'Directory permission organization',owner_id),(foreign_org,'Other directory org',outsider);
  insert into public.org_members(org_id,user_id,role) values
    (org,owner_id,'owner'),(org,admin_id,'admin'),(org,member_id,'member'),(org,creator,'member'),(foreign_org,outsider,'owner');
  insert into public.projects(id,user_id,org_id,name,visibility) values
    (public_item,creator,org,'Directory permission public','organization'),
    (private_item,creator,org,'Directory permission private','private'),
    (opened_item,creator,org,'Directory permission opened','private'),
    (ownerless,null,org,'Directory permission ownerless','private'),
    (departed_item,departed,org,'Directory permission departed creator','private'),
    (stale_deny,creator,org,'Directory permission stale deny','private'),
    (foreign_item,outsider,foreign_org,'Directory permission foreign','organization'),
    (personal_item,owner_id,null,'Directory permission personal','private');
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values
    (public_item,org,member_id,'deny'),(public_item,org,admin_id,'deny'),(stale_deny,org,owner_id,'deny');
  -- A historical private deny can survive a change to public visibility.
  update public.projects set visibility='organization' where id=stale_deny;
  assert exists(select 1 from public.project_org_access_overrides where project_id=stale_deny and role='deny'),'fixture retains the stale owner deny';
  assert pg_temp.directory_has(owner_id,public_item),'organization owner sees public work';
  assert not pg_temp.directory_has(member_id,public_item) and not pg_temp.directory_has(admin_id,public_item),'member and admin public denies are authoritative';
  assert pg_temp.directory_has(owner_id,stale_deny),'organization owner public standing precedes a stale deny';
  foreach actor in array array[owner_id,admin_id,member_id] loop
    assert not pg_temp.directory_has(actor,private_item),'organization role alone cannot reveal a member private project';
  end loop;
  assert pg_temp.directory_has(creator,private_item),'active creator retains private ownership';
  assert pg_temp.directory_has(owner_id,ownerless) and not pg_temp.directory_has(admin_id,ownerless)
    and not pg_temp.directory_has(member_id,ownerless),'only organization owner inherits ownerless private work';
  assert not pg_temp.directory_has(departed,departed_item),'former creator cannot bypass active organization membership';
  assert not pg_temp.directory_has(owner_id,foreign_item),'foreign organization remains inaccessible';
  assert not pg_temp.directory_has(owner_id,public_item,'personal') and not pg_temp.directory_has(owner_id,personal_item,org::text),'workspace boundaries exclude opposite placement';
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values
    (private_item,org,owner_id,'viewer'),(private_item,org,admin_id,'editor'),(private_item,org,member_id,'viewer');
  foreach actor in array array[owner_id,admin_id,member_id] loop
    assert pg_temp.directory_has(actor,private_item),'explicit private role admits exactly the grantee';
  end loop;
  perform public.set_org_private_content_permission(org,owner_id,admin_id,true);
  perform public.open_org_private_content(org,owner_id,'project',opened_item);
  perform public.open_org_private_content(org,admin_id,'project',opened_item);
  assert pg_temp.directory_has(owner_id,opened_item) and pg_temp.directory_has(admin_id,opened_item)
    and not pg_temp.directory_has(member_id,opened_item),'administrative private openings are explicit and actor-specific';
  -- Compare the whole result set with the detail-access oracle for every
  -- actor/workspace combination; exact ids detect both leaks and omissions.
  foreach actor in array array[owner_id,admin_id,member_id,creator,departed,outsider] loop
    foreach scope in array array[null::text,'personal',org::text,foreign_org::text] loop
      select array_agg(p.id order by p.id) into expected from public.projects p
        where p.name like 'Directory permission%' and public.workspace_matches(scope,p.org_id)
          and public.project_access_role(p.id,p.user_id,p.org_id,actor::text,actor||'@example.test') is not null;
      select array_agg((p->>'id')::uuid order by (p->>'id')::uuid) into actual
        from jsonb_array_elements(public.search_project_directory(actor::text,actor||'@example.test','Directory permission',100,0,scope)) p;
      assert actual is not distinct from expected,'directory/detail authorization parity across complete actor and workspace matrix';
    end loop;
  end loop;
end;
$$;
rollback;
