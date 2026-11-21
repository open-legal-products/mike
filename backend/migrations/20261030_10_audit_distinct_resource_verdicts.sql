-- Migration date: 2026-10-30
-- Audit history may contain many events for the same resource. Resolve live
-- permissions per distinct resource and join the verdict back to each event.
-- Search still operates on redacted titles: hidden titles cannot affect counts.
create or replace function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text,p_event_ids uuid[])
returns setof public.audit_events language sql stable set search_path=public,pg_temp as $$
  with events as materialized (
    select a.* from public.audit_events a where a.org_id=p_org_id
      and (p_event_ids is null or a.id=any(p_event_ids)) and exists(
        select 1 from public.active_org_members m where m.org_id=p_org_id and m.user_id=p_actor_id and m.role in ('owner','admin'))
  ), actor as materialized (
    select public.can_access_org_private_content(p_org_id,p_actor_id) opens_private
  ), documents as materialized (
    select d.* from (select distinct document_id from events where document_id is not null) ids
    join public.documents d on d.id=ids.document_id and d.org_id=p_org_id and d.archived_at is null
  ), chats as materialized (
    select c.*,public.chat_access_role(c.id,c.user_id,c.project_id,c.org_id,p_actor_id::text,p_actor_email) role
    from (select distinct chat_id from events where chat_id is not null) ids
    join public.chats c on c.id=ids.chat_id and c.org_id=p_org_id and c.archived_at is null
  ), reviews as materialized (
    select r.*,public.review_access_role(r.id,r.user_id,r.project_id,r.org_id,p_actor_id::text,p_actor_email) role
    from (select distinct review_id from events where review_id is not null) ids
    join public.tabular_reviews r on r.id=ids.review_id and r.org_id=p_org_id and r.archived_at is null
  ), projects as materialized (
    select p.id,public.project_access_role(p.id,p.user_id,p.org_id,p_actor_id::text,p_actor_email) role
    from (select project_id from events where project_id is not null union select project_id from documents where project_id is not null) ids
    join public.projects p on p.id=ids.project_id and p.org_id=p_org_id
  ), workflows as materialized (
    select w.id,public.workflow_access_role(w.id,w.user_id,w.org_id,p_actor_id::text,p_actor_email) role
    from (select distinct workflow_id from documents where workflow_id is not null) ids
    join public.workflows w on w.id=ids.workflow_id and w.org_id=p_org_id
  ), document_verdicts as materialized (
    select d.id,(p.role is not null or w.role is not null
      or (d.project_id is null and d.workflow_id is null and d.user_id=p_actor_id)
      or public.org_private_document_access(d.org_id,d.id,p_actor_id::text)) can_view
    from documents d left join projects p on p.id=d.project_id left join workflows w on w.id=d.workflow_id
  ), targets as materialized (
    select a.id,
      case when a.document_id is not null then case when d.project_id is not null then 'project' when d.workflow_id is not null then 'workflow' else 'document' end
        when a.review_id is not null then case when r.project_id is not null then 'project' else 'tabular_review' end
        when a.chat_id is not null then case when c.project_id is not null then 'project' else 'chat' end
        when a.project_id is not null then 'project'
        when a.action in ('org.private_content.opened','org.private_content.closed') then a.detail->>'kind'
        when a.detail->>'workflow_id' is not null then 'workflow' end kind,
      case when a.document_id is not null then coalesce(d.project_id,d.workflow_id,d.id)::text
        when a.review_id is not null then coalesce(r.project_id,r.id)::text
        when a.chat_id is not null then coalesce(c.project_id,c.id)::text
        when a.project_id is not null then p.id::text
        when a.action in ('org.private_content.opened','org.private_content.closed') then a.detail->>'item_id'
        else a.detail->>'workflow_id' end item_id
    from events a left join documents d on d.id=a.document_id left join reviews r on r.id=a.review_id
      left join chats c on c.id=a.chat_id left join projects p on p.id=a.project_id
  ), private_descriptors as materialized (
    select target.kind,target.item_id,jsonb_build_object('kind',item.kind,'item_id',item.item_id,
      'has_access',public.org_private_access_role(p_org_id,item.kind,item.item_id,p_actor_id::text) is not null) access
    from (select distinct kind,item_id from targets where item_id is not null) target
    cross join lateral public.org_private_content_item(p_org_id,target.kind,
      case when target.item_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then target.item_id::uuid end) item
    where (select opens_private from actor) and item.user_id is distinct from p_actor_id
  ), scoped as (
    select a.*,pd.access as private_access,(
      pd.access is not null
      or (a.action like 'org.%' and (a.action not in ('org.private_content.opened','org.private_content.closed') or (select opens_private from actor)))
      or a.user_id=p_actor_id or p.role is not null or c.role is not null or r.role is not null or d.can_view
    ) can_view
    from events a left join targets t on t.id=a.id left join private_descriptors pd on pd.kind=t.kind and pd.item_id=t.item_id
      left join projects p on p.id=a.project_id left join chats c on c.id=a.chat_id
      left join reviews r on r.id=a.review_id left join document_verdicts d on d.id=a.document_id
  )
  select (jsonb_populate_record(null::public.audit_events,(to_jsonb(s)-'can_view'-'private_access')||
    case when s.can_view then jsonb_build_object('detail',
      case when s.private_access is null then s.detail-'private_content_access'
        else (coalesce(s.detail,'{}'::jsonb)-'private_content_access')||jsonb_build_object('private_content_access',s.private_access) end)
    else jsonb_build_object('title',null,'detail',null,'project_id',null,'chat_id',null,'review_id',null,'document_id',null) end
  )).* from scoped s;
$$;
