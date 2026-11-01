-- S11: resolving a grant email to its account is one probe of the partial
-- lower(email) index, not a pass over every profile on the platform.
begin;
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select sum(pg_stat_get_xact_tuples_returned(c.oid)+pg_stat_get_xact_tuples_fetched(c.oid))::bigint
  from pg_class c where c.oid=rel or c.oid in (select indexrelid from pg_index where indrelid=rel);
$$;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  before bigint; reads bigint; items integer;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into auth.users(id,email) select gen_random_uuid(),'profile-'||n||'@example.test' from generate_series(1,2000) n;
  insert into public.organizations(id,name,created_by) values(org,'Grant emails',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member');
  insert into public.chats(org_id,user_id,title) select org,member_id,'Shared '||n from generate_series(1,20) n;
  insert into public.chat_access_grants(chat_id,email,role,created_by)
    select id,owner_id||'@example.test','editor',member_id from public.chats where org_id=org;
  -- A large org: holders are no longer a small set to drive the join from.
  insert into public.org_members(org_id,user_id,role)
    select org,id,'member' from auth.users where email like 'profile-%@example.test';
  analyze public.user_profiles; analyze public.org_members;
  before:=pg_temp.rel_work('public.user_profiles');
  select count(*) into items from public.org_members_departure_items(org,array[member_id]) where disposition='transfer';
  reads:=pg_temp.rel_work('public.user_profiles')-before;
  assert items=20,'chats shared with a remaining member still transfer';
  assert reads<500,format('departure read %s profile rows to resolve 20 grant emails',reads);
end;
$$;
rollback;
