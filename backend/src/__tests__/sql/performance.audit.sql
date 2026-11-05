-- C7: preserve redaction while evaluating permissions per distinct resource.
begin;
create or replace function pg_temp.audit_oracle(p_org_id uuid,p_actor_id uuid,p_actor_email text,p_event_ids uuid[])
returns setof public.audit_events language sql stable set search_path = public, pg_temp as $$
  with scoped as (
    select a.*, private_item.access as private_access, (
      private_item.access is not null
      or (a.action like 'org.%' and (a.action not in ('org.private_content.opened','org.private_content.closed') or public.can_access_org_private_content(p_org_id,p_actor_id)))
      or a.user_id=p_actor_id
      or public.project_access_role(p.id,p.user_id,p.org_id,p_actor_id::text,p_actor_email) is not null
      or public.chat_access_role(c.id,c.user_id,c.project_id,c.org_id,p_actor_id::text,p_actor_email) is not null
      or public.review_access_role(v.id,v.user_id,v.project_id,v.org_id,p_actor_id::text,p_actor_email) is not null
      or (d.id is not null and (
        public.project_access_role(dp.id,dp.user_id,dp.org_id,p_actor_id::text,p_actor_email) is not null
        or public.workflow_access_role(w.id,w.user_id,w.org_id,p_actor_id::text,p_actor_email) is not null
        or (d.project_id is null and d.workflow_id is null and d.user_id=p_actor_id and d.archived_at is null)
        or public.org_private_document_access(d.org_id,d.id,p_actor_id::text)
      ))
    ) as can_view
    from public.audit_events a
    left join public.projects p on p.id=a.project_id and p.org_id=p_org_id
    left join public.chats c on c.id=a.chat_id and c.org_id=p_org_id and c.archived_at is null
    left join public.tabular_reviews v on v.id=a.review_id and v.org_id=p_org_id and v.archived_at is null
    left join public.documents d on d.id=a.document_id and d.org_id=p_org_id and d.archived_at is null
    left join public.projects dp on dp.id=d.project_id and dp.org_id=p_org_id
    left join public.workflows w on w.id=d.workflow_id and w.org_id=p_org_id
    left join lateral (
      select jsonb_build_object('kind',item.kind,'item_id',item.item_id,'has_access',
        public.org_private_access_role(p_org_id,item.kind,item.item_id,p_actor_id::text) is not null) as access
      from public.org_private_content_items(p_org_id) item
      where public.can_access_org_private_content(p_org_id,p_actor_id)
        and item.user_id is distinct from p_actor_id
        -- Resolve the affected item first, then its current private parent.
        -- Missing, archived, or moved items cannot fall back to another ID on
        -- the old event. Catalog membership enforces current organization scope.
        and (item.kind,item.item_id::text) = (
          case
            when a.document_id is not null then case when d.project_id is not null then 'project' when d.workflow_id is not null then 'workflow' else 'document' end
            when a.review_id is not null then case when v.project_id is not null then 'project' else 'tabular_review' end
            when a.chat_id is not null then case when c.project_id is not null then 'project' else 'chat' end
            when a.project_id is not null then 'project'
            when a.action in ('org.private_content.opened','org.private_content.closed') then a.detail->>'kind'
            when a.detail->>'workflow_id' is not null then 'workflow'
          end,
          case
            when a.document_id is not null then coalesce(d.project_id,d.workflow_id,d.id)::text
            when a.review_id is not null then coalesce(v.project_id,v.id)::text
            when a.chat_id is not null then coalesce(c.project_id,c.id)::text
            when a.project_id is not null then p.id::text
            when a.action in ('org.private_content.opened','org.private_content.closed') then a.detail->>'item_id'
            else a.detail->>'workflow_id'
          end
        )
    ) private_item on true
    where a.org_id=p_org_id and (p_event_ids is null or a.id=any(p_event_ids)) and exists(
      select 1 from public.active_org_members m where m.org_id=p_org_id and m.user_id=p_actor_id and m.role in ('owner','admin')
    )
  )
  select (jsonb_populate_record(null::public.audit_events, (to_jsonb(s)-'can_view'-'private_access') ||
    case when s.can_view then jsonb_build_object('detail',
      -- This descriptor is server-derived, never trusted from stored metadata.
      case when s.private_access is null then s.detail-'private_content_access'
        else (coalesce(s.detail,'{}'::jsonb)-'private_content_access') || jsonb_build_object('private_content_access',s.private_access) end
    ) else jsonb_build_object(
      'title',null,'detail',null,'project_id',null,'chat_id',null,'review_id',null,'document_id',null
    ) end
  )).* from scoped s;
$$;
create temporary sequence audit_project_calls minvalue 0 start 0;
-- Live rows a statement read from a table: sequential and bitmap heap reads
-- plus heap fetches through its indexes. Index entries alone are not
-- counted, because rolled-back fixtures in other suites leave dead entries
-- that an index scan steps over until vacuum.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select (pg_stat_get_xact_tuples_returned(rel)+pg_stat_get_xact_tuples_fetched(rel)
    +coalesce((select sum(pg_stat_get_xact_tuples_fetched(indexrelid)) from pg_index where indrelid=rel),0))::bigint;
$$;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid(); project uuid:=gen_random_uuid();
  expected jsonb; actual jsonb; actor_id uuid; before bigint;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test'),(admin_id,admin_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Audit resource grouping',owner_id),(other_org,'Other audit org',owner_id);
  insert into public.org_members(org_id,user_id,role) values(other_org,owner_id,'owner');
  insert into public.audit_events(org_id,user_id,action,title) select other_org,owner_id,'project.updated','Other org '||n from generate_series(1,3) n;
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member'),(org,admin_id,'admin');
  insert into public.projects(id,org_id,user_id,name) values(project,org,member_id,'Private title');
  insert into public.audit_events(org_id,user_id,action,title,project_id,detail)
    select org,member_id,'project.updated','Private title '||n,project,jsonb_build_object('n',n) from generate_series(1,1000) n;
  foreach actor_id in array array[owner_id,admin_id,member_id] loop
    select jsonb_agg(to_jsonb(e) order by id) into expected from pg_temp.audit_oracle(org,actor_id,'',null) e;
    select jsonb_agg(to_jsonb(e) order by id) into actual from public.organization_audit_events(org,actor_id,'',null) e;
    assert actual is not distinct from expected,'redacted rows must match original policy exactly';
    -- S6: a page's ids are the same rows the oracle filters to, and ids
    -- of another organization's events are never returned.
    select jsonb_agg(to_jsonb(e) order by id) into expected
      from pg_temp.audit_oracle(org,actor_id,'',array(select id from public.audit_events where org_id=org order by id limit 7)
        ||array(select id from public.audit_events where org_id=other_org)) e;
    select jsonb_agg(to_jsonb(e) order by id) into actual
      from public.organization_audit_events(org,actor_id,'',array(select id from public.audit_events where org_id=org order by id limit 7)
        ||array(select id from public.audit_events where org_id=other_org)) e;
    assert actual is not distinct from expected,'paged rows must match original policy exactly';
    assert not exists(select 1 from jsonb_array_elements(coalesce(actual,'[]')) e where (e->>'org_id')::uuid<>org),
      'another organization''s event ids must not resolve';
  end loop;
  -- S6: resolving one page of ids reads those events, not the org's history.
  analyze public.audit_events;
  before:=pg_temp.rel_work('public.audit_events');
  perform * from public.organization_audit_events(org,admin_id,'',array(select id from public.audit_events where org_id=org limit 1));
  assert pg_temp.rel_work('public.audit_events')-before<=10,
    format('one event id read %s audit rows',pg_temp.rel_work('public.audit_events')-before);
  perform set_config('mike.test_audit_org',org::text,true);perform set_config('mike.test_audit_actor',admin_id::text,true);
end;
$$;
alter function public.project_access_role(uuid,uuid,uuid,text,text) rename to audit_project_oracle;
create function public.project_access_role(p_project_id uuid,p_project_user_id uuid,p_org_id uuid,p_user_id text,p_user_email text)
returns text language plpgsql set search_path=public as $$
begin perform nextval('pg_temp.audit_project_calls');return public.audit_project_oracle(p_project_id,p_project_user_id,p_org_id,p_user_id,p_user_email);end;
$$;
create or replace function public.org_private_content_items(p_org_id uuid)
returns table(kind text,item_id uuid,title text,user_id uuid) language plpgsql stable set search_path=public,pg_temp as $$
begin raise exception 'Audit redaction must not enumerate the catalogue';end;
$$;
do $$
declare result jsonb;
begin
  result:=public.organization_audit_events_page(current_setting('mike.test_audit_org')::uuid,current_setting('mike.test_audit_actor')::uuid,'',jsonb_build_object('title_pattern','%Private%'));
  assert result->>'total'='0','hidden titles must not affect search count';
  assert (select last_value=0 and is_called from pg_temp.audit_project_calls),'1,000 events for one project must produce one project verdict';
end;
$$;
rollback;

-- M-S6: the username filter resolves matching profiles once per page call,
-- among the organization's actors, instead of probing a profile per event.
-- Events, order and the total count are unchanged.
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
declare admin_id uuid:=gen_random_uuid(); alice uuid:=gen_random_uuid(); busy uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  pattern text; result jsonb; expected_ids jsonb; expected_total bigint; before bigint; reads bigint;
begin
  insert into auth.users(id,email) values(admin_id,admin_id||'@example.test'),(alice,'alice@example.test'),(busy,busy||'@example.test');
  update public.user_profiles set display_name='Alice Smith' where user_id=alice;
  update public.user_profiles set display_name='Busy Robot' where user_id=busy;
  -- Everyone else on the platform, none of whom acts in this organization.
  insert into auth.users(id,email) select gen_random_uuid(),'platform-'||n||'@example.test' from generate_series(1,3000) n;
  insert into public.organizations(id,name,created_by) values(org,'Username filter',admin_id);
  insert into public.org_members(org_id,user_id,role) values(org,admin_id,'owner');
  insert into public.audit_events(org_id,user_id,user_email,action,created_at)
    select org,busy,'recorded-'||n||'@example.test','project.updated',now()-n*interval '1 second' from generate_series(1,3000) n;
  insert into public.audit_events(org_id,user_id,user_email,action,created_at)
    select org,alice,'old-address@example.test','chat.created',now()-n*interval '1 minute' from generate_series(1,5) n;
  analyze public.audit_events; analyze public.user_profiles;
  foreach pattern in array array['%alice%','%SMITH%','%robot%','%recorded-7%','%old-address%','%nobody%'] loop
    -- The original predicate, evaluated directly.
    select coalesce(jsonb_agg(id order by created_at desc,id),'[]'),count(*) into expected_ids,expected_total from (
      select a.id,a.created_at from public.audit_events a where a.org_id=org and (a.user_email ilike pattern
        or exists(select 1 from public.user_profiles profile where profile.user_id=a.user_id
          and (profile.display_name ilike pattern or profile.email ilike pattern)))
      order by a.created_at desc,a.id limit 50) page;
    select count(*) into expected_total from public.audit_events a where a.org_id=org and (a.user_email ilike pattern
        or exists(select 1 from public.user_profiles profile where profile.user_id=a.user_id
          and (profile.display_name ilike pattern or profile.email ilike pattern)));
    before:=pg_temp.rel_work('public.user_profiles');
    result:=public.organization_audit_events_page(org,admin_id,'',jsonb_build_object('username_pattern',pattern));
    reads:=pg_temp.rel_work('public.user_profiles')-before;
    assert (select coalesce(jsonb_agg(e->'id'),'[]') from jsonb_array_elements(result->'events') e)=expected_ids,
      format('username filter %s changed the page',pattern);
    assert (result->>'total')::bigint=expected_total,format('username filter %s changed the total',pattern);
    assert reads<50,format('username filter %s read %s profile rows',pattern,reads);
  end loop;
end;
$$;
rollback;
