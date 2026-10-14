-- Migration date: 2026-10-14
-- Discover private organization items from their audit events. Viewing an event
-- does not open the item: the existing audited open transaction grants viewer.
create or replace function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text)
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
    where a.org_id=p_org_id and exists(
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
revoke all on function public.organization_audit_events(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.organization_audit_events(uuid,uuid,text) to service_role;
