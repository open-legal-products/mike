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
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); project uuid:=gen_random_uuid();
  expected jsonb; actual jsonb; actor_id uuid;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test'),(admin_id,admin_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Audit resource grouping',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member'),(org,admin_id,'admin');
  insert into public.projects(id,org_id,user_id,name) values(project,org,member_id,'Private title');
  insert into public.audit_events(org_id,user_id,action,title,project_id,detail)
    select org,member_id,'project.updated','Private title '||n,project,jsonb_build_object('n',n) from generate_series(1,1000) n;
  foreach actor_id in array array[owner_id,admin_id,member_id] loop
    select jsonb_agg(to_jsonb(e) order by id) into expected from pg_temp.audit_oracle(org,actor_id,'',null) e;
    select jsonb_agg(to_jsonb(e) order by id) into actual from public.organization_audit_events(org,actor_id,'',null) e;
    assert actual is not distinct from expected,'redacted rows must match original policy exactly';
  end loop;
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
