-- Migration date: 2026-10-30
create index if not exists workflow_shares_lower_email_idx on public.workflow_shares(lower(shared_with_email));
create or replace function public.workflow_list_access(p_user_id text,p_user_email text,p_workspace text default null)
returns table(workflow_id uuid,role text) language sql stable set search_path=public,pg_temp as $$
  with actor as materialized (
    select case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end id,
      nullif(lower(p_user_email),'') email
  ), candidates as materialized (
    select w.id from public.workflows w where w.user_id=(select id from actor)
    union select w.id from public.org_members m join public.workflows w on w.org_id=m.org_id where m.user_id=(select id from actor)
    union select g.workflow_id from public.workflow_shares g where lower(g.shared_with_email)=(select email from actor)
    union select a.item_id from public.org_private_content_access a where a.user_id=(select id from actor) and a.kind='workflow'
  ), verdicts as materialized (
    select w.id,public.workflow_access_role(w.id,w.user_id,w.org_id,p_user_id,p_user_email) role
    from candidates c cross join lateral (select item.* from public.workflows item where item.id=c.id offset 0) w
    where case when p_workspace is null then true when p_workspace='personal' then w.org_id is null else w.org_id=p_workspace::uuid end
  ) select id,role from verdicts where role is not null;
$$;
revoke all on function public.workflow_list_access(text,text,text) from public,anon,authenticated;
grant execute on function public.workflow_list_access(text,text,text) to service_role;

create or replace function public.get_workflows_overview(
  p_user_id text,
  p_user_email text default null,
  p_type text default null
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
set search_path=public,pg_temp
as $$
  with accessible as materialized (
    select w.*,access.role as list_role
    from public.workflow_list_access(p_user_id,p_user_email,null) access
    join public.workflows w on w.id=access.workflow_id
  ), owned as (
    select
      w.id,
      w.user_id::text as user_id,
      w.org_id,
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      true as allow_edit,
      true as is_owner,
      null::text as shared_by_name,
      0 as sort_bucket
    from accessible w
    where w.user_id::text = p_user_id
      and w.list_role is not null
      and (p_type is null or w.type = p_type)
  ),
  shared as (
    select
      w.id,
      w.user_id::text as user_id,
      w.org_id,
      'shared'::text as access_scope,
      null::text as organization_name,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      (ws.role in ('owner', 'editor')) as allow_edit,
      (ws.role = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      1 as sort_bucket
    from public.workflow_shares ws
    join accessible w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id = ws.shared_by_user_id
    where lower(ws.shared_with_email) = lower(coalesce(p_user_email, ''))
      and w.org_id is null
      and (p_type is null or w.type = p_type)
  ),
  org_shared as (
    -- Workflows in an org the caller belongs to. Admins default to Owner and
    -- Members default to Editor; per-workflow overrides may narrow either.
    -- Mirrors resolveWorkflowAccess in routes/workflows.ts, so a row's
    -- affordances in the list match what the detail route will allow.
    select
      w.id,
      w.user_id::text as user_id,
      w.org_id,
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title,
      w.type,
      w.prompt_md,
      w.columns_config,
      w.language,
      w.practice,
      w.jurisdictions,
      false as is_system,
      w.created_at,
      (w.list_role in ('owner', 'editor')) as allow_edit,
      (w.list_role = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from accessible w
    left join public.user_profiles up
      on up.user_id = w.user_id
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and w.list_role is not null
  ),
  visible_workflows as (
    select * from owned
    union all
    select * from shared
    union all
    select * from org_shared
  )
  select
    vw.id,
    vw.user_id,
    vw.org_id,
    vw.access_scope,
    vw.organization_name,
    vw.title,
    vw.type,
    vw.prompt_md,
    vw.columns_config,
    vw.language,
    vw.practice,
    vw.jurisdictions,
    vw.is_system,
    vw.created_at,
    vw.allow_edit,
    vw.is_owner,
    vw.shared_by_name
  from visible_workflows vw
  order by vw.sort_bucket asc, vw.created_at desc;
$$;

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
set search_path=public,pg_temp
as $$
  with accessible as materialized (
    select w.*,access.role as list_role
    from public.workflow_list_access(p_user_id,p_user_email,p_workspace) access
    join public.workflows w on w.id=access.workflow_id
  ), owned as (
    select
      w.id, w.user_id::text as user_id, w.org_id,
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
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
    from accessible w
    where w.user_id::text = p_user_id
      and w.list_role is not null
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
    join accessible w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id = ws.shared_by_user_id
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
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
      (
        select nullif(trim(o.name), '')
        from public.organizations o
        where o.id = w.org_id
      ) as organization_name,
      w.title, w.type, w.prompt_md,
      w.columns_config, w.language, w.practice, w.jurisdictions,
      false as is_system, w.created_at,
      (w.list_role in ('owner', 'editor')) as allow_edit,
      (w.list_role = 'owner') as is_owner,
      nullif(trim(up.display_name), '') as shared_by_name,
      2 as sort_bucket
    from accessible w
    left join public.user_profiles up
      on up.user_id = w.user_id
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
      and w.list_role is not null
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
      or (p_scope = 'public' and vw.access_scope = 'organization')
      or (p_scope = 'nonpublic' and vw.access_scope <> 'organization')
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
set search_path=public,pg_temp
as $$
  with accessible as materialized (
    select w.*,access.role as list_role
    from public.workflow_list_access(p_user_id,p_user_email,p_workspace) access
    join public.workflows w on w.id=access.workflow_id
  ), owned as (
    select
      w.id, w.user_id::text as user_id,
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 0 as sort_bucket
    from accessible w
    where w.user_id::text = p_user_id
      and w.list_role is not null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  shared as (
    select
      w.id, w.user_id::text as user_id, 'shared'::text as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 1 as sort_bucket
    from public.workflow_shares ws
    join accessible w
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
      w.id, w.user_id::text as user_id, public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
      w.title, w.practice, w.language, w.jurisdictions,
      w.created_at, 2 as sort_bucket
    from accessible w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
      and w.list_role is not null
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
      or (p_scope = 'public' and vw.access_scope = 'organization')
      or (p_scope = 'nonpublic' and vw.access_scope <> 'organization')
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
set search_path=public,pg_temp
as $$
  with accessible as materialized (
    select w.*,access.role as list_role
    from public.workflow_list_access(p_user_id,p_user_email,p_workspace) access
    join public.workflows w on w.id=access.workflow_id
  ), owned as (
    select w.practice, w.language, w.jurisdictions, 'owned'::text as source
    from accessible w
    where w.user_id::text = p_user_id
      and w.list_role is not null
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
  ),
  shared as (
    select w.practice, w.language, w.jurisdictions, 'shared'::text as source
    from public.workflow_shares ws
    join accessible w on w.id = ws.workflow_id
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
    from accessible w
    where w.org_id is not null
      and (w.user_id is null or w.user_id::text <> p_user_id)
      and (p_type is null or w.type = p_type)
      and public.workspace_matches(p_workspace, w.org_id)
      and w.list_role is not null
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
