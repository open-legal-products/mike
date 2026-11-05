-- M-S9: the private-content catalogue pages each kind in (lower(title), id)
-- order and stops at offset+limit rows per kind; pages, order, titles and
-- access flags equal the original full sort.
begin;
-- The function as it was before paging per kind.
create function pg_temp.private_catalogue_oracle(p_org_id uuid,p_actor_id uuid,p_limit integer default 50,p_offset integer default 0,p_search text default '')
returns table(kind text,item_id uuid,title text,user_id uuid,display_name text,email text,has_access boolean)
language plpgsql stable set search_path=public,pg_temp as $$
begin
  if not public.can_access_org_private_content(p_org_id,p_actor_id) then
    raise exception 'Private content permission required' using errcode='42501';
  end if;
  return query select item.kind,item.item_id,item.title,item.user_id,profile.display_name,profile.email,
    exists(select 1 from public.org_private_content_access a where a.org_id=p_org_id and a.user_id=p_actor_id and a.kind=item.kind and a.item_id=item.item_id)
    from public.org_private_content_items(p_org_id) item left join public.user_profiles profile on profile.user_id=item.user_id
    where item.user_id is distinct from p_actor_id and (p_search='' or position(lower(p_search) in lower(coalesce(item.title,'')))>0)
    order by lower(item.title) nulls last,item.kind,item.item_id
    limit greatest(1,least(p_limit,101)) offset greatest(0,p_offset);
end;
$$;
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
  probe record; actual jsonb; expected jsonb; before bigint; reads bigint; doc uuid;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Catalogue',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member');
  -- Shared titles across kinds and within a kind, case differences, nulls,
  -- the actor's own items (excluded), public and project-bound items.
  insert into public.projects(org_id,user_id,name,visibility) select org,member_id,(array['Alpha','alpha','Beta','Zeta'])[1+n%4],'private' from generate_series(1,12) n;
  insert into public.projects(org_id,user_id,name,visibility) values(org,member_id,'Alpha','organization'),(org,owner_id,'Alpha','private');
  insert into public.workflows(org_id,user_id,title,type,visibility) select org,member_id,(array['Alpha','Gamma'])[1+n%2],'assistant','private' from generate_series(1,6) n;
  insert into public.chats(org_id,user_id,title) select org,member_id,case when n%7=0 then null else (array['Alpha','beta','Chat'])[1+n%3] end from generate_series(1,40) n;
  insert into public.chats(org_id,user_id,title,project_id) select org,member_id,'Alpha',id from public.projects where org_id=org limit 1;
  insert into public.tabular_reviews(org_id,user_id,title) select org,member_id,(array['Alpha','Review'])[1+n%2] from generate_series(1,8) n;
  for n in 1..6 loop
    insert into public.documents(org_id,user_id) values(org,member_id) returning id into doc;
    if n%3<>0 then
      insert into public.document_versions(document_id,version_number,filename) values(doc,1,(array['alpha.pdf','Beta.docx'])[1+n%2]);
      update public.documents set current_version_id=(select id from public.document_versions where document_id=doc) where id=doc;
    end if;
  end loop;
  perform public.open_org_private_content(org,owner_id,'chat',(select id from public.chats where org_id=org and project_id is null order by id limit 1));
  for probe in select * from (values(''),('alpha'),('ALPHA'),('a'),('missing')) s(search) cross join (values(0),(3),(10),(40),(70)) o(page_offset) cross join (values(1),(7),(101)) l(page_limit) loop
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into expected from pg_temp.private_catalogue_oracle(org,owner_id,probe.page_limit,probe.page_offset,probe.search) x;
    select coalesce(jsonb_agg(to_jsonb(x)),'[]') into actual from public.list_org_private_content(org,owner_id,probe.page_limit,probe.page_offset,probe.search) x;
    assert actual=expected,format('catalogue page changed for search %L offset %s limit %s',probe.search,probe.page_offset,probe.page_limit);
  end loop;
  -- A large organization: the first page reads about one page per kind.
  insert into public.chats(org_id,user_id,title) select org,member_id,'Bulk '||n from generate_series(1,3000) n;
  insert into public.projects(org_id,user_id,name,visibility) select org,member_id,'Bulk '||n,'private' from generate_series(1,3000) n;
  analyze public.chats; analyze public.projects;
  before:=pg_temp.rel_work('public.chats')+pg_temp.rel_work('public.projects');
  perform * from public.list_org_private_content(org,owner_id,10,0,'');
  reads:=pg_temp.rel_work('public.chats')+pg_temp.rel_work('public.projects')-before;
  assert reads<200,format('a 10-row catalogue page read %s chat and project rows',reads);
end;
$$;
rollback;
