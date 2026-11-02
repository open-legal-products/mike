-- Migration date: 2026-10-11
--
-- Let every list RPC be narrowed to one workspace.
--
-- A person may belong to several organizations and also holds personal
-- content. Until now each list mixed all of it together, with nothing to say
-- which firm's work was on screen. Each list RPC below gains an optional
-- p_workspace parameter: null (every workspace, the previous behaviour),
-- 'personal' (org_id is null) or an organization id.
--
-- The filter only narrows. Visibility is still decided by the access-role
-- functions, so passing an organization the caller does not belong to returns
-- nothing. No data changes.
--
-- Adding a parameter changes a function's identity, so each old signature is
-- dropped before the new one is created; otherwise both would exist and
-- PostgREST could not choose between them.
--
-- Safe to re-run: drop if exists plus create or replace.

create or replace function public.workspace_matches(
  p_workspace text,
  p_org_id uuid
)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when p_workspace is null then true
    when p_workspace = 'personal' then p_org_id is null
    else p_org_id = p_workspace::uuid
  end;
$$;

drop function if exists public.get_chats_overview(text, text, integer, integer, timestamptz, uuid);
create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_workspace text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  updated_at timestamptz,
  project_name text,
  is_owner boolean,
  access_role text
)
language sql
stable
set search_path = public
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    c.updated_at,
    p.name as project_name,
    -- Provenance ("I started this thread"), not a role: the ladder itself is
    -- lib/permissions.ts, and the creator branch of ensureChatAccess is what
    -- turns this into Owner standing.
    coalesce(c.user_id::text = p_user_id, false) as is_owner,
    -- The SAME verdict the predicate below filters on, served to the caller.
    -- Serving only is_owner was not enough: the client must distinguish
    -- Editor and Viewer from Owner so its actions match the server verdict.
    -- One evaluation, one truth: the lateral computes the role once and both
    -- the column and the WHERE read it.
    verdict.role as access_role
  from public.chats c
  left join public.projects p on p.id = c.project_id
  cross join lateral (
    select public.chat_access_role(
             c.id,
             c.user_id,
             c.project_id,
             c.org_id,
             p_user_id,
             p_user_email
           ) as role
  ) verdict
  -- The whole predicate, in one call.
  -- The join above is for project_name only; the function resolves the
  -- project itself.
  where verdict.role is not null
    and public.workspace_matches(p_workspace, c.org_id)
    and (
      p_before_updated_at is null
      or c.updated_at < p_before_updated_at
      or (c.updated_at = p_before_updated_at and c.id > p_before_id)
    )
  order by c.updated_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_tabular_reviews_overview(text, text, text, text, integer, integer, text, text, text);
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
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vr.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vr.created_at else null end desc,
    vr.created_at desc,
    vr.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_tabular_review_ids_overview(text, text, text, text, text, integer, integer);
create or replace function public.get_tabular_review_ids_overview(
  p_user_id text,
  p_user_email text,
  p_project_id text,
  p_scope text,
  p_search_term text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text
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
  )
  select tr.id, tr.user_id::text as user_id
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
  order by tr.created_at desc, tr.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_project_filter_options(text, text);
create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_workspace text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
      and public.workspace_matches(p_workspace, p.org_id)
  ),
  distinct_owners as (
    -- NULL is not an owner. A project whose creator's account was deleted
    -- carries user_id = NULL (on delete set null), and emitting it here put
    -- an option with value null in the owner dropdown -- selecting which made
    -- `p_owner_user_id is null or ...` true for EVERY row, so the filter
    -- silently turned itself off instead of filtering.
    select distinct vp.user_id
    from visible_projects vp
    where vp.user_id is not null
  ),
  owner_options as (
    select
      o.user_id,
      case
        when o.user_id::text = p_user_id then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id::text = o.user_id::text
  )
  select
    coalesce(
      (select array_agg(distinct practice order by practice)
       from visible_projects
       where practice is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      (select jsonb_agg(
          jsonb_build_object('value', user_id, 'label', label)
          order by label, user_id
       ) from owner_options),
      '[]'::jsonb
    ) as owners;
$$;

drop function if exists public.get_workflow_filter_options(text, text, text, text);
create or replace function public.get_workflow_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_type text default null,
  p_scope text default 'all',
  p_workspace text default null
)
returns table (
  practices text[],
  languages text[],
  jurisdictions text[]
)
language sql
stable
as $$
  with owned as (
    select w.practice, w.language, w.jurisdictions, 'owned'::text as source
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  shared as (
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflow_shares ws
    join public.workflows w on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  org_shared as (
    -- Same org-membership arm as get_workflows_overview, including the
    -- workflow_shares NOT EXISTS dedup, so a row visible via both routes
    -- contributes its options exactly once. Tagged 'shared' to match the
    -- overview's scope bucketing.
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflows w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  ),
  scoped as (
    select * from visible
    where coalesce(p_scope, 'all') = 'all' or source = p_scope
  )
  select
    coalesce(
      array_agg(distinct nullif(trim(practice), '') order by nullif(trim(practice), ''))
        filter (where nullif(trim(practice), '') is not null),
      array[]::text[]
    ) as practices,
    coalesce(
      array_agg(distinct nullif(trim(language), '') order by nullif(trim(language), ''))
        filter (where nullif(trim(language), '') is not null),
      array[]::text[]
    ) as languages,
    coalesce(
      (select array_agg(distinct jurisdiction order by jurisdiction)
       from scoped s
       cross join lateral unnest(coalesce(s.jurisdictions, array[]::text[])) jurisdiction
       where nullif(trim(jurisdiction), '') is not null),
      array[]::text[]
    ) as jurisdictions
  from scoped;
$$;

drop function if exists public.get_projects_overview(text, text, text, integer, integer, text, text, text, text, text);
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
  p_workspace text default null
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
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) is not null
      and public.workspace_matches(p_workspace, p.org_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id::text = p_user_id)
        or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
        or (
          p_scope = 'collaborative'
          and (
            p.org_id is not null
            or p.user_id is null
            or p.user_id::text <> p_user_id
            or exists (
              select 1 from public.project_access_grants g
              where g.project_id = p.id
            )
          )
        )
        or (
          p_scope = 'private'
          and p.org_id is null
          and p.user_id::text = p_user_id
          and not exists (
            select 1 from public.project_access_grants g
            where g.project_id = p.id
          )
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
      and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    case
      when vp.org_id is not null then 'organization'
      when exists (
        select 1 from public.project_access_grants g
        where g.project_id = vp.id
      ) then 'shared'
      else 'private'
    end as access_scope,
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
    coalesce(vp.user_id::text = p_user_id, false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    public.project_access_role(
      vp.id, vp.user_id, vp.org_id, p_user_id, p_user_email
    ) as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id::text = vp.user_id::text
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_project_ids_overview(text, text, text, text, text, text, integer, integer);
create or replace function public.get_project_ids_overview(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_owner_user_id text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select p.id, p.user_id::text as user_id
  from public.projects p
  where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
    and public.workspace_matches(p_workspace, p.org_id)
    and (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'mine' and p.user_id::text = p_user_id)
      or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
      or (
        p_scope = 'collaborative'
        and (
          p.org_id is not null
          or p.user_id is null
          or p.user_id::text <> p_user_id
          or exists (
            select 1 from public.project_access_grants g
            where g.project_id = p.id
          )
        )
      )
      or (
        p_scope = 'private'
        and p.org_id is null
        and p.user_id::text = p_user_id
        and not exists (
          select 1 from public.project_access_grants g
          where g.project_id = p.id
        )
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
    and (p_owner_user_id is null or p.user_id::text = p_owner_user_id)
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_workflows_overview(text, text, text, text, integer, integer, text, text, text, text, text, text);
create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_language text,
  p_jurisdiction text,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  title text,
  type text,
  prompt_md text,
  columns_config jsonb,
  language text,
  practice text,
  jurisdictions text[],
  is_system boolean,
  created_at timestamptz,
  allow_edit boolean,
  is_owner boolean,
  shared_by_name text
)
language sql
stable
as $$
  with owned as (
    select
      w.id, w.user_id::text as user_id, w.org_id,
      case
        when w.org_id is not null then 'organization'
        when exists (
          select 1 from public.workflow_shares scope_share
          where scope_share.workflow_id = w.id
        ) then 'shared'
        else 'private'
      end as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      true as allow_edit, true as is_owner, null::text as shared_by_name,
      0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, w.org_id,
      'shared'::text as access_scope, null::text as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      (ws.role in ('owner', 'editor')) as allow_edit,
      (ws.role = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  org_shared as (
    -- Workflows in an org the caller belongs to. Admins default to Owner and
    -- Members default to Editor; per-workflow overrides may narrow either.
    -- Mirrors resolveWorkflowAccess in routes/workflows.ts and the legacy
    -- 3-argument overload. Under the scope filter these rows count as
    -- "shared" — shared-with-me and shared-via-my-org are one bucket from
    -- the caller's point of view.
    select
      w.id, w.user_id::text as user_id, w.org_id,
      'organization'::text as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      (public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) in ('owner', 'editor')) as allow_edit,
      (public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from public.workflows w
    left join public.user_profiles up
      on up.user_id::text = w.user_id::text
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select
    vw.id, vw.user_id, vw.org_id, vw.access_scope, vw.organization_name,
    vw.title, vw.type, vw.prompt_md, vw.columns_config,
    vw.language, vw.practice, vw.jurisdictions, vw.is_system, vw.created_at,
    vw.allow_edit, vw.is_owner, vw.shared_by_name
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket in (1, 2))
      or (p_scope = 'private' and vw.access_scope = 'private')
      or (
        p_scope = 'collaborative'
        and vw.access_scope in ('shared', 'organization')
      )
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vw.title, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vw.title, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then vw.type else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then vw.type else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vw.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vw.created_at else null end desc,
    vw.sort_bucket asc,
    vw.created_at desc,
    vw.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_workflow_ids_overview(text, text, text, text, text, text, text, text, integer, integer);
create or replace function public.get_workflow_ids_overview(
  p_user_id text,
  p_user_email text,
  p_type text,
  p_scope text,
  p_search_term text,
  p_practice text,
  p_language text,
  p_jurisdiction text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  with owned as (
    select
      w.id, w.user_id::text as user_id,
      case
        when w.org_id is not null then 'organization'
        when exists (
          select 1 from public.workflow_shares scope_share
          where scope_share.workflow_id = w.id
        ) then 'shared'
        else 'private'
      end as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 0 as sort_bucket
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, 'shared'::text as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 1 as sort_bucket
    from public.workflow_shares ws
    join public.workflows w
      on w.id = ws.workflow_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  org_shared as (
    -- Same org-membership arm as get_workflows_overview: the ids RPC must
    -- compute the same visible set, or "select all matching" silently
    -- omits org-shared rows the list view shows.
    select
      w.id, w.user_id::text as user_id, 'organization'::text as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 2 as sort_bucket
    from public.workflows w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select vw.id, vw.user_id
  from visible_workflows vw
  where (
      coalesce(p_scope, 'all') = 'all'
      or (p_scope = 'owned' and vw.sort_bucket = 0)
      or (p_scope = 'shared' and vw.sort_bucket in (1, 2))
      or (p_scope = 'private' and vw.access_scope = 'private')
      or (
        p_scope = 'collaborative'
        and vw.access_scope in ('shared', 'organization')
      )
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(vw.title) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (p_practice is null or vw.practice = p_practice)
    and (p_language is null or vw.language = p_language)
    and (p_jurisdiction is null or vw.jurisdictions @> array[p_jurisdiction])
  order by vw.sort_bucket asc, vw.created_at desc, vw.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
drop function if exists public.get_project_summaries(text, text, integer, integer);
create or replace function public.get_project_summaries(
  p_user_id text,
  p_user_email text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text,
  name text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean
)
language sql
stable
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    coalesce(p.user_id::text = p_user_id, false) as is_owner
  from public.projects p
  where public.project_access_role(
    p.id, p.user_id, p.org_id, p_user_id, p_user_email
  ) is not null
    and public.workspace_matches(p_workspace, p.org_id)
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
