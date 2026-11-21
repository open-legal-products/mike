-- S11: resolving a grant email to its account is one probe of the partial
-- lower(email) index, not a pass over every profile on the platform.
begin;
-- Live rows a statement read from a table: sequential and bitmap heap reads
-- plus heap fetches through its indexes. Index entries alone are not
-- counted, because rolled-back fixtures in other suites leave dead entries
-- that an index scan steps over until vacuum.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select (pg_stat_get_xact_tuples_returned(rel)+pg_stat_get_xact_tuples_fetched(rel)
    +coalesce((select sum(pg_stat_get_xact_tuples_fetched(indexrelid)) from pg_index where indrelid=rel),0))::bigint;
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

-- M-S5: departure roots are found from the departing members' own items and
-- owner grants; the root conditions run for those, not for every item in
-- the organization. The result equals the pre-rewrite function.
begin;
\ir oracles/departure-items.sql
-- A fixture this small makes sequential scans look cheapest; switch them off
-- so the counters show which rows the plan's shape has to visit.
set local enable_seqscan=off;
-- Live rows a statement read from a table: sequential and bitmap heap reads
-- plus heap fetches through its indexes. Index entries alone are not
-- counted, because rolled-back fixtures in other suites leave dead entries
-- that an index scan steps over until vacuum.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select (pg_stat_get_xact_tuples_returned(rel)+pg_stat_get_xact_tuples_fetched(rel)
    +coalesce((select sum(pg_stat_get_xact_tuples_fetched(indexrelid)) from pg_index where indrelid=rel),0))::bigint;
$$;
create function pg_temp.rows_read(variadic rels regclass[]) returns bigint language sql as $$
  select sum(pg_temp.rel_work(rel))::bigint from unnest(rels) rel;
$$;
do $$
declare owner_id uuid:=gen_random_uuid(); stay uuid:=gen_random_uuid(); leave1 uuid:=gen_random_uuid(); leave2 uuid:=gen_random_uuid();
  outsider uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); item uuid; actual jsonb; expected jsonb; before bigint; reads bigint;
begin
  insert into auth.users(id,email) select x,x||'@example.test' from unnest(array[owner_id,stay,leave1,leave2,outsider]) x;
  insert into public.organizations(id,name,created_by) values(org,'Departure roots',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,stay,'member'),(org,leave1,'member'),(org,leave2,'member');
  -- Projects and workflows: created by a leaver (private / public / shared
  -- with a stayer / co-owned by a stayer), and created by someone gone but
  -- owned by a leaver through an override.
  foreach item in array array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid()] loop
    insert into public.projects(id,org_id,user_id,name,visibility) values(item,org,
      case when (select count(*) from public.projects where org_id=org)=4 then outsider else leave1 end,'Root','private');
  end loop;
  update public.projects set visibility='organization' where id=(select id from public.projects where org_id=org order by id limit 1);
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role)
    select id,org,stay,case when row_number() over (order by id)=1 then 'editor' else 'owner' end from (select id from public.projects where org_id=org and user_id=leave1 order by id offset 1 limit 2) x;
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role)
    select id,org,leave2,'owner' from public.projects where org_id=org and user_id=outsider;
  insert into public.workflows(org_id,user_id,title,type,visibility) values(org,leave1,'Root','assistant','private'),(org,leave2,'Public','assistant','organization');
  insert into public.workflows(org_id,user_id,title,type,visibility) values(org,outsider,'Co-owned','assistant','private') returning id into item;
  insert into public.workflow_org_access_overrides(workflow_id,org_id,user_id,role) values(item,org,leave1,'owner');
  -- Chats and reviews: created by a leaver (plain / shared with a stayer),
  -- and created by someone gone with a leaver granted owner.
  insert into public.chats(org_id,user_id,title) values(org,leave1,'Plain'),(org,leave2,'Shared');
  insert into public.chat_access_grants(chat_id,email,role,created_by) select id,stay||'@example.test','viewer',leave2 from public.chats where org_id=org and title='Shared';
  insert into public.chats(org_id,user_id,title) values(org,outsider,'Granted') returning id into item;
  insert into public.chat_access_grants(chat_id,email,role,created_by) values(item,leave1||'@example.test','owner',outsider);
  insert into public.tabular_reviews(org_id,user_id,title) values(org,leave2,'Plain');
  insert into public.tabular_reviews(org_id,user_id,title) values(org,outsider,'Granted') returning id into item;
  insert into public.tabular_review_access_grants(tabular_review_id,email,role,created_by) values(item,leave2||'@example.test','owner',outsider);
  insert into public.tabular_review_access_grants(tabular_review_id,email,role,created_by) values(item,stay||'@example.test','editor',outsider);
  insert into public.documents(org_id,user_id) values(org,leave1),(org,leave2);
  -- The rest of the organization, created by 200 other members and
  -- untouched by this departure.
  insert into auth.users(id,email) select gen_random_uuid(),'colleague-'||n||'@example.test' from generate_series(1,200) n;
  insert into public.org_members(org_id,user_id,role) select org,id,'member' from auth.users where email like 'colleague-%';
  create temporary table colleagues as select row_number() over (order by id) n,id from auth.users where email like 'colleague-%';
  insert into public.projects(org_id,user_id,name) select org,c.id,'Other '||g from generate_series(1,1000) g join colleagues c on c.n=1+g%200;
  insert into public.workflows(org_id,user_id,title,type) select org,c.id,'Other '||g,'assistant' from generate_series(1,1000) g join colleagues c on c.n=1+g%200;
  insert into public.chats(org_id,user_id,title) select org,c.id,'Other '||g from generate_series(1,1000) g join colleagues c on c.n=1+g%200;
  insert into public.tabular_reviews(org_id,user_id,title) select org,c.id,'Other '||g from generate_series(1,1000) g join colleagues c on c.n=1+g%200;
  analyze public.projects; analyze public.workflows; analyze public.chats; analyze public.tabular_reviews;
  analyze public.org_members; analyze public.user_profiles; analyze public.documents;
  analyze public.project_org_access_overrides; analyze public.workflow_org_access_overrides;
  analyze public.chat_access_grants; analyze public.tabular_review_access_grants;
  select jsonb_agg(to_jsonb(o) order by o.kind,o.item_id) into expected from pg_temp.departure_items_oracle(org,array[leave1,leave2]) o;
  before:=pg_temp.rows_read('public.projects','public.workflows','public.chats','public.tabular_reviews');
  select jsonb_agg(to_jsonb(o) order by o.kind,o.item_id) into actual from public.org_members_departure_items(org,array[leave1,leave2]) o;
  reads:=pg_temp.rows_read('public.projects','public.workflows','public.chats','public.tabular_reviews')-before;
  assert jsonb_array_length(expected)=14,format('fixture: %s departure items',jsonb_array_length(expected));
  assert actual=expected,format('departure items changed: %s vs %s',actual,expected);
  assert reads<500,format('departure read %s organization items to find 12 roots in a 4,000-item org',reads);
end;
$$;
rollback;
