-- H2: one-item verdicts must never materialize the complete private catalogue.
begin;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  doc uuid:=gen_random_uuid(); item record;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Keyed private access',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member');
  insert into public.documents(id,org_id,user_id) values(doc,org,member_id);
  insert into public.org_private_content_access(org_id,user_id,kind,item_id) values(org,owner_id,'document',doc);
  for item in select * from public.org_private_content_items(org) loop
    assert exists(select 1 from public.org_private_content_item(org,item.kind,item.item_id) p
      where p.title is not distinct from item.title and p.user_id is not distinct from item.user_id), 'keyed catalogue parity';
  end loop;
  perform set_config('mike.test_private_org',org::text,true);
  perform set_config('mike.test_private_owner',owner_id::text,true);
  perform set_config('mike.test_private_doc',doc::text,true);
end;
$$;
create or replace function public.org_private_content_items(p_org_id uuid)
returns table(kind text,item_id uuid,title text,user_id uuid) language plpgsql stable set search_path=public,pg_temp as $$
begin raise exception 'Single-item permission check expanded the whole catalogue'; end;
$$;
do $$
declare org uuid:=current_setting('mike.test_private_org')::uuid; actor text:=current_setting('mike.test_private_owner');
  doc uuid:=current_setting('mike.test_private_doc')::uuid;
begin
  assert public.org_private_access_role(org,'document',doc,actor)='viewer', 'keyed role';
  assert public.org_private_document_access(org,doc,actor), 'keyed document role';
  assert (select count(*)=1 from public.list_org_private_content_access(array[org],actor)), 'keyed opened-item list';
  assert public.org_private_access_role(org,'document',doc,'not-a-uuid') is null, 'malformed actor remains denied';
  assert not has_function_privilege('authenticated','public.org_private_content_item(uuid,text,uuid)','EXECUTE'), 'helper is service-only';
end;
$$;
rollback;
-- Exercise all item types, revoke/demotion, archive/move, atomic audit failure,
-- private title redaction, and pagination against the optimized functions.
\ir ../../modules/orgs/__tests__/orgs.privateContent.sql
\ir ../../modules/orgs/__tests__/orgs.auditPrivateContent.sql
\ir ../../modules/orgs/__tests__/orgs.auditPagination.sql
