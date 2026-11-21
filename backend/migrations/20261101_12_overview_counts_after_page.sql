-- Migration date: 2026-11-01
-- get_projects_overview counted documents, chats and reviews, and
-- get_tabular_reviews_overview counted distinct documents (including a
-- count(distinct) over tabular_cells for legacy reviews), for EVERY visible
-- row before ORDER BY ... LIMIT kept one page. Counts are now computed for
-- every row only when the caller sorts by a count, and otherwise for the
-- page's rows only. Rows, order and values are unchanged.
create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text,
  p_workspace text default null,
  p_participating_only boolean default false
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
set search_path=public,pg_temp
as $$
  with visible_projects as (
    select p.*, access.role as list_access_role
    from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
    where (
        p_participating_only is not true
        or p.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
        or (p.org_id is null and exists (
          select 1 from public.project_access_grants participation
          where participation.project_id=p.id and participation.email=lower(trim(p_user_email))
        ))
        or (p.org_id is not null and exists (
          select 1 from public.project_org_access_overrides participation
          where participation.project_id=p.id
            and participation.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
            and participation.role in ('owner','editor','viewer')
        ))
      )
      and public.workspace_matches(p_workspace, p.org_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end))
        or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
        or (
          p_scope = 'collaborative'
          and (
            p.user_id is null
            or p.user_id::text <> p_user_id
            or public.project_access_scope(p.id, p.org_id, p.visibility) <> 'private'
          )
        )
        or (
          p_scope = 'private'
          and p.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
          and public.project_access_scope(p.id, p.org_id, p.visibility) = 'private'
        )
        -- The Public and Private tabs: public is open to the whole
        -- organization; everything else, shared with individuals or not, is
        -- private.
        or (
          p_scope = 'public'
          and public.project_access_scope(p.id, p.org_id, p.visibility) = 'organization'
        )
        or (
          p_scope = 'nonpublic'
          and public.project_access_scope(p.id, p.org_id, p.visibility) <> 'organization'
        )
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id = (case when p_owner_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_owner_user_id::uuid end))
  ),
  -- Page first. Counts are computed for every visible project only when the
  -- caller sorts by one (it orders the whole list); otherwise only for the
  -- page's rows. CASE evaluates a count subquery only when its key is chosen.
  page as materialized (
    select * from (
      select vp.*,
        case when p_sort_key = 'files' then (select count(*)::integer from public.documents d where d.project_id = vp.id) end as sort_document_count,
        case when p_sort_key = 'chats' then (select count(*)::integer from public.chats c where c.project_id = vp.id) end as sort_chat_count,
        case when p_sort_key = 'reviews' then (select count(*)::integer from public.tabular_reviews tr where tr.project_id = vp.id) end as sort_review_count
      from visible_projects vp
    ) vp
    order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then vp.sort_document_count else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then vp.sort_document_count else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then vp.sort_chat_count else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then vp.sort_chat_count else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then vp.sort_review_count else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then vp.sort_review_count else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    public.project_access_scope(vp.id, vp.org_id, vp.visibility) as access_scope,
    (
      select nullif(trim(o.name), '')
      from public.organizations o
      where o.id = vp.org_id
    ) as organization_name,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end), false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    vp.list_access_role as access_role,
    coalesce(vp.sort_document_count, (select count(*)::integer from public.documents d where d.project_id = vp.id)) as document_count,
    coalesce(vp.sort_chat_count, (select count(*)::integer from public.chats c where c.project_id = vp.id)) as chat_count,
    coalesce(vp.sort_review_count, (select count(*)::integer from public.tabular_reviews tr where tr.project_id = vp.id)) as review_count
  from page vp
  left join public.user_profiles up
    on up.user_id = vp.user_id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then vp.sort_document_count else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then vp.sort_document_count else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then vp.sort_chat_count else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then vp.sort_chat_count else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then vp.sort_review_count else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then vp.sort_review_count else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc;
$$;

create or replace function public.get_tabular_reviews_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_workspace text default null,
  p_owner_user_id text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  columns_config jsonb,
  document_ids jsonb,
  workflow_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  access_role text,
  document_count integer
)
language sql
stable
set search_path=public,pg_temp
as $$
  with visible_reviews as (
    select tr.*,access.role as list_access_role
    from public.review_list_access(p_user_id,p_user_email,p_project_id,p_workspace) access
    join public.tabular_reviews tr on tr.id=access.review_id
    where (p_project_id is null or tr.project_id = (case when p_project_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_project_id::uuid end))
      and public.workspace_matches(p_workspace, tr.org_id)
      and (p_owner_user_id is null or tr.user_id = (case when p_owner_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_owner_user_id::uuid end))
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'in-project' and tr.project_id is not null)
        or (p_scope = 'standalone' and tr.project_id is null)
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(tr.title) like
          '%' ||
          replace(
            replace(
              replace(lower(p_search_term), '\', '\\'),
              '%',
              '\%'
            ),
            '_',
            '\_'
          ) ||
          '%'
          escape '\'
      )
  ),
  -- Page first. Document counts are computed for every visible review only
  -- when the caller sorts by them; otherwise only for the page's rows.
  page as materialized (
    select * from (
      select vr.*,
        case when p_sort_key = 'documents' then case
          when jsonb_typeof(vr.document_ids) = 'array'
            then (
              select count(distinct doc_id.value)::integer
              from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
            )
          else (
            select count(distinct tc.document_id)::integer
            from public.tabular_cells tc
            where tc.review_id = vr.id
          )
        end end as sort_document_count
      from visible_reviews vr
    ) vr
    order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, '')) else null end desc,
    case when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end asc,
    case when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end desc,
    case when p_sort_key = 'documents' and p_sort_direction = 'asc' then vr.sort_document_count else null end asc,
    case when p_sort_key = 'documents' and p_sort_direction = 'desc' then vr.sort_document_count else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then coalesce(vr.updated_at, vr.created_at) else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then coalesce(vr.updated_at, vr.created_at) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at else null end desc,
    vr.created_at desc,
    vr.id asc
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select
    vr.id,
    vr.project_id,
    vr.user_id::text as user_id,
    vr.title,
    vr.columns_config,
    vr.document_ids,
    vr.workflow_id,
    vr.created_at,
    vr.updated_at,
    coalesce(vr.user_id::text = p_user_id, false) as is_owner,
    vr.list_access_role as access_role,
    coalesce(vr.sort_document_count, case
          when jsonb_typeof(vr.document_ids) = 'array'
            then (
              select count(distinct doc_id.value)::integer
              from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
            )
          else (
            select count(distinct tc.document_id)::integer
            from public.tabular_cells tc
            where tc.review_id = vr.id
          )
        end) as document_count
  from page vr
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, '')) else null end desc,
    case when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end asc,
    case when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end desc,
    case when p_sort_key = 'documents' and p_sort_direction = 'asc' then vr.sort_document_count else null end asc,
    case when p_sort_key = 'documents' and p_sort_direction = 'desc' then vr.sort_document_count else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then coalesce(vr.updated_at, vr.created_at) else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then coalesce(vr.updated_at, vr.created_at) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at else null end desc,
    vr.created_at desc,
    vr.id asc;
$$;
