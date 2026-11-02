-- Migration date: 2026-10-15
-- Sort review history before pagination, preserving workspace and access checks.

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
  p_workspace text default null
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
as $$
  with accessible_projects as (
    select p.id
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
  ),
  visible_reviews as (
    select tr.*
    from public.tabular_reviews tr
    where (p_project_id is null or tr.project_id::text = p_project_id)
      and public.workspace_matches(p_workspace, tr.org_id)
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
      and (
        p_project_id is null
        or exists (
          select 1
          from accessible_projects ap
          where ap.id::text = p_project_id
        )
      )
      and public.review_access_role(
        tr.id, tr.user_id, tr.project_id, tr.org_id,
        p_user_id, p_user_email
      ) is not null
  ),
  cell_document_counts as (
    select
      tc.review_id,
      count(distinct tc.document_id)::integer as document_count
    from public.tabular_cells tc
    where tc.review_id in (
      select vr.id
      from visible_reviews vr
      where jsonb_typeof(vr.document_ids) is distinct from 'array'
    )
    group by tc.review_id
  ),
  review_document_counts as (
    select
      vr.id,
      case
        when jsonb_typeof(vr.document_ids) = 'array'
          then (
            select count(distinct doc_id.value)::integer
            from jsonb_array_elements_text(vr.document_ids) as doc_id(value)
          )
        else coalesce(cdc.document_count, 0)
      end as document_count
    from visible_reviews vr
    left join cell_document_counts cdc
      on cdc.review_id = vr.id
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
    public.review_access_role(
      vr.id, vr.user_id, vr.project_id, vr.org_id,
      p_user_id, p_user_email
    ) as access_role,
    rdc.document_count
  from visible_reviews vr
  join review_document_counts rdc
    on rdc.id = vr.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vr.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vr.title, '')) else null end desc,
    case when p_sort_key = 'columns' and p_sort_direction = 'asc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end asc,
    case when p_sort_key = 'columns' and p_sort_direction = 'desc' then jsonb_array_length(coalesce(vr.columns_config, '[]'::jsonb)) else null end desc,
    case when p_sort_key = 'documents' and p_sort_direction = 'asc' then rdc.document_count else null end asc,
    case when p_sort_key = 'documents' and p_sort_direction = 'desc' then rdc.document_count else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then coalesce(vr.updated_at, vr.created_at) else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then coalesce(vr.updated_at, vr.created_at) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at else null end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
