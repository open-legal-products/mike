-- Migration date: 2026-10-30
create or replace function public.review_list_access(p_user_id text,p_user_email text,p_project_id text,p_workspace text)
returns table(review_id uuid,role text) language sql stable set search_path=public,pg_temp as $$
  with actor as materialized (
    select case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end id,
      nullif(lower(p_user_email),'') email,
      case when p_project_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_project_id::uuid end project_id
  ), project_roles as materialized (
    -- A requested project is one PK lookup, not an all-projects permission scan.
    select p.id project_id,public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) role
      from public.projects p where p.id=(select project_id from actor)
    union all
    select * from public.project_list_access(p_user_id,p_user_email,p_workspace) where p_project_id is null
  ), candidates as materialized (
    select r.id from project_roles p join public.tabular_reviews r on r.project_id=p.project_id where p.role is not null
    union select r.id from public.tabular_reviews r where p_project_id is null and r.user_id=(select id from actor)
    union select g.tabular_review_id from public.tabular_review_access_grants g where p_project_id is null and g.email=(select email from actor)
    union select a.item_id from public.org_private_content_access a where p_project_id is null and a.user_id=(select id from actor) and a.kind='tabular_review'
  ), verdicts as materialized (
    select r.id,case when r.project_id is not null then p.role
      else public.review_access_role(r.id,r.user_id,r.project_id,r.org_id,p_user_id,p_user_email) end role
    from candidates c
    cross join lateral (select item.* from public.tabular_reviews item where item.id=c.id offset 0) r
    left join project_roles p on p.project_id=r.project_id
    where r.archived_at is null and public.org_is_active(r.org_id)
      and case when p_workspace is null then true when p_workspace='personal' then r.org_id is null else r.org_id=p_workspace::uuid end
  ) select id,role from verdicts where role is not null;
$$;
revoke all on function public.review_list_access(text,text,text,text) from public,anon,authenticated;
grant execute on function public.review_list_access(text,text,text,text) to service_role;

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
    vr.list_access_role as access_role,
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

create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null,
  p_owner_user_id text default null
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
set search_path=public,pg_temp
as $$
  select tr.id, tr.user_id::text as user_id
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
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
