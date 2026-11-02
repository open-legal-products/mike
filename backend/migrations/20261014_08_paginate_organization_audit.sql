-- Migration date: 2026-10-14
-- Restrict expensive audit redaction to selected rows without relaxing search_path.
create or replace function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text,p_event_ids uuid[])
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
revoke all on function public.organization_audit_events(uuid,uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.organization_audit_events(uuid,uuid,text,uuid[]) to service_role;

-- Preserve the existing unpaged SQL API for internal callers.
create or replace function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text)
returns setof public.audit_events language sql stable set search_path = public, pg_temp as $$
  select * from public.organization_audit_events(p_org_id,p_actor_id,p_actor_email,null::uuid[]);
$$;
revoke all on function public.organization_audit_events(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.organization_audit_events(uuid,uuid,text) to service_role;

-- Page and count authorized metadata before resolving resource access. Title
-- search/sort deliberately redact first so hidden titles cannot affect results.
create or replace function public.organization_audit_events_page(
  p_org_id uuid, p_actor_id uuid, p_actor_email text,
  p_filter jsonb default '{}'::jsonb,
  p_sort_by text default 'created_at', p_sort_direction text default 'desc',
  p_offset integer default 0, p_limit integer default 50
) returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare candidates text; filtered text; result jsonb; ordering text;
begin
  if not exists(select 1 from public.active_org_members m
    where m.org_id=p_org_id and m.user_id=p_actor_id and m.role in ('owner','admin')) then
    return jsonb_build_object('events','[]'::jsonb,'total',0);
  end if;
  if p_sort_by is null or p_sort_by not in ('created_at','user_email','title','model')
    or p_sort_direction is null or p_sort_direction not in ('asc','desc') then
    raise exception 'Invalid audit sort' using errcode='22023';
  end if;
  p_limit:=greatest(1,least(coalesce(p_limit,50),2000));
  p_offset:=greatest(0,least(coalesce(p_offset,0),200000000));
  ordering:=format('%I %s nulls last, id asc',p_sort_by,p_sort_direction);
  -- Only allowlisted sort identifiers are interpolated. All filter values
  -- remain bound parameters, including arrays, search patterns and dates.
  candidates:=$query$
    select a.* from public.audit_events a where a.org_id=$1
      and ($4->>'username_pattern' is null or a.user_email ilike $4->>'username_pattern'
        or exists(select 1 from public.user_profiles profile where profile.user_id=a.user_id
          and (profile.display_name ilike $4->>'username_pattern' or profile.email ilike $4->>'username_pattern')))
      and ($4->>'action' is null or a.action=$4->>'action')
      and ($4->>'status' is null or a.status=$4->>'status')
      and ($4->>'surface' is null or a.surface=$4->>'surface')
      and ($4->>'actor_user_id' is null or a.user_id=($4->>'actor_user_id')::uuid)
      and ($4->>'from' is null or a.created_at>=($4->>'from')::timestamptz)
      and ($4->>'to' is null or a.created_at<=($4->>'to')::timestamptz)
      and (not ($4 ? 'event_ids') or a.id=any(array(select jsonb_array_elements_text($4->'event_ids')::uuid)))
      and (not ($4 ? 'user_ids') or a.user_id=any(array(select jsonb_array_elements_text($4->'user_ids')::uuid)))
  $query$;
  if p_filter->>'title_pattern' is not null or p_sort_by='title' then
    -- These operations depend on visible titles, so they necessarily inspect
    -- the metadata-filtered candidates. Materialize once for both count/page.
    filtered:=format($query$
      with candidates as (%s), visible as materialized (
        select * from public.organization_audit_events($1,$2,$3,array(select id from candidates))
      ), filtered as not materialized (
        select * from visible where $4->>'title_pattern' is null or title ilike $4->>'title_pattern'
      ), page as (select * from filtered order by %s limit $5 offset $6)
      select jsonb_build_object(
        'events',coalesce((select jsonb_agg(to_jsonb(page) order by %s) from page),'[]'::jsonb),
        'total',(select count(*) from filtered))
    $query$,candidates,ordering,ordering);
  else
    -- NOT MATERIALIZED permits the count and page to use separate index scans.
    -- The expensive resource joins/permission checks see only this page's IDs.
    filtered:=format($query$
      with candidates as not materialized (%s),
      page as materialized (select id from candidates order by %s limit $5 offset $6),
      visible as (
        select * from public.organization_audit_events($1,$2,$3,array(select id from page))
      )
      select jsonb_build_object(
        'events',coalesce((select jsonb_agg(to_jsonb(visible) order by %s) from visible),'[]'::jsonb),
        'total',(select count(*) from candidates))
    $query$,candidates,ordering,ordering);
  end if;
  execute filtered into result using p_org_id,p_actor_id,p_actor_email,coalesce(p_filter,'{}'::jsonb),p_limit,p_offset;
  return result;
end;
$$;
revoke all on function public.organization_audit_events_page(uuid,uuid,text,jsonb,text,text,integer,integer) from public,anon,authenticated;
grant execute on function public.organization_audit_events_page(uuid,uuid,text,jsonb,text,text,integer,integer) to service_role;
