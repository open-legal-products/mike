-- Migration date: 2026-10-30
-- Walk forward from the item to its references, then verify existence by PK.
-- Never enumerate unrelated platform documents to ask whether each is linked.
create or replace function public.org_item_document_ids(p_kind text,p_item_id uuid)
returns table(document_id uuid) language sql stable set search_path=public as $$
  with item_chats as materialized (
    select c.id from public.chats c where p_kind='project' and c.project_id=p_item_id
    union all select p_item_id where p_kind='chat'
  ), item_reviews as materialized (
    select r.id,r.document_ids from public.tabular_reviews r
    where (p_kind='project' and r.project_id=p_item_id) or (p_kind='tabular_review' and r.id=p_item_id)
  ), references_raw as (
    select d.id::text id from public.documents d where p_kind='project' and d.project_id=p_item_id
    union all select d.id::text from public.documents d where p_kind='workflow' and d.workflow_id=p_item_id
    union all select f.value->>'document_id'
      from item_chats c join public.chat_messages m on m.chat_id=c.id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(m.files)='array' then m.files else '[]'::jsonb end) f
      where jsonb_typeof(f.value->'document_id')='string'
    union all select value #>> '{}' from item_reviews r
      cross join lateral jsonb_array_elements(case when jsonb_typeof(r.document_ids)='array' then r.document_ids else '[]'::jsonb end) j(value)
      where jsonb_typeof(value)='string'
    -- The historical ? predicate also recognized object keys and a scalar
    -- string. Preserve those legacy shapes without accepting malformed UUIDs.
    union all select key from item_reviews r cross join lateral jsonb_object_keys(
      case when jsonb_typeof(r.document_ids)='object' then r.document_ids else '{}'::jsonb end) j(key)
    union all select r.document_ids #>> '{}' from item_reviews r where jsonb_typeof(r.document_ids)='string'
    union all select row.document_id::text from item_reviews r join public.tabular_review_rows row on row.review_id=r.id
    union all select source.document_id::text from item_reviews r join public.tabular_review_rows row on row.review_id=r.id
      join public.tabular_review_row_sources source on source.row_id=row.id
  ), reference_ids as (
    select distinct case when id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then id::uuid end id
    from references_raw
  )
  select d.id from reference_ids ref
  cross join lateral (
    select existing.id from public.documents existing where existing.id=ref.id offset 0
  ) d;
$$;

create or replace function public.org_members_departure_items(p_org_id uuid,p_user_ids uuid[])
returns table(kind text,item_id uuid,title text,disposition text)
language sql stable set search_path = public as $$
  with roots as (
select 'project'::text kind,item.id item_id,
    case when item.visibility='organization' then item.name else null::text end title,
    case when (item.visibility='organization' or exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.projects item where item.org_id=p_org_id and item.archived_at is null

    and (item.user_id=any(p_user_ids) or exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
 union all
select 'workflow'::text kind,item.id item_id,
    case when item.visibility='organization' then item.title else null::text end title,
    case when (item.visibility='organization' or exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.workflows item where item.org_id=p_org_id and item.archived_at is null

    and (item.user_id=any(p_user_ids) or exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
 union all
select 'chat'::text kind,item.id item_id,
    null::text title,
    case when (exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.chats item where item.org_id=p_org_id and item.archived_at is null
    and item.project_id is null
    and (item.user_id=any(p_user_ids) or exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
 union all
select 'tabular_review'::text kind,item.id item_id,
    null::text title,
    case when (exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.tabular_reviews item where item.org_id=p_org_id and item.archived_at is null
    and item.project_id is null
    and (item.user_id=any(p_user_ids) or exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
  ), retained_items as materialized (
    select 'chat'::text kind,c.id from public.chats c
    where c.org_id=p_org_id and c.archived_at is null
      and not exists(select 1 from public.projects p where p.id=c.project_id and p.archived_at is not null)
      and not exists(select 1 from roots r where r.kind='chat' and r.item_id=c.id and r.disposition='archive')
      and (c.project_id is null or not exists(select 1 from roots r where r.kind='project' and r.item_id=c.project_id and r.disposition='archive'))
    union all
    select 'tabular_review',tr.id from public.tabular_reviews tr
    where tr.org_id=p_org_id and tr.archived_at is null
      and not exists(select 1 from public.projects p where p.id=tr.project_id and p.archived_at is not null)
      and not exists(select 1 from roots r where r.kind='tabular_review' and r.item_id=tr.id and r.disposition='archive')
      and (tr.project_id is null or not exists(select 1 from roots r where r.kind='project' and r.item_id=tr.project_id and r.disposition='archive'))
  ), retained_documents as materialized (
    select distinct ref.document_id from retained_items item
    cross join lateral public.org_item_document_ids(item.kind,item.id) ref
  ), documents as (
    select 'document'::text kind,d.id item_id,null::text title,
      case when d.id in (select document_id from retained_documents) then 'transfer' else 'archive' end disposition
    from public.documents d where d.org_id=p_org_id and d.user_id=any(p_user_ids)
      and d.project_id is null and d.workflow_id is null and d.archived_at is null
  ) select * from roots union all select * from documents;
$$;
