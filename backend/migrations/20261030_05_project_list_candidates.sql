-- Migration date: 2026-10-30
-- Candidate ids are a union of indexed ownership/membership/grant lookups.
-- The final access ladder is still authoritative; candidates only avoid
-- asking it about projects that cannot possibly be visible to this actor.
create index if not exists org_private_content_access_actor_kind_idx
  on public.org_private_content_access(user_id,kind,org_id,item_id);
create or replace function public.project_list_access(p_user_id text,p_user_email text,p_workspace text default null)
returns table(project_id uuid,role text) language sql stable set search_path=public,pg_temp as $$
  with actor as materialized (
    select case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end id,
      nullif(lower(p_user_email),'') email
  ), candidates as materialized (
    select p.id from public.projects p where p.user_id=(select id from actor)
    union select p.id from public.org_members m join public.projects p on p.org_id=m.org_id where m.user_id=(select id from actor)
    union select g.project_id from public.project_access_grants g where g.email=(select email from actor)
    union select a.item_id from public.org_private_content_access a where a.user_id=(select id from actor) and a.kind='project'
  ), verdicts as materialized (
    select p.id,public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) role
    from candidates c cross join lateral (select item.* from public.projects item where item.id=c.id offset 0) p
    where case when p_workspace is null then true when p_workspace='personal' then p.org_id is null else p.org_id=p_workspace::uuid end
  ) select id,role from verdicts where role is not null;
$$;
revoke all on function public.project_list_access(text,text,text) from public,anon,authenticated;
grant execute on function public.project_list_access(text,text,text) to service_role;

create or replace function public.get_projects_overview(
  p_user_id text,
  p_user_email text default null
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
    from public.project_list_access(p_user_id,p_user_email,null) access
    join public.projects p on p.id=access.project_id
    where true
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
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id = vp.user_id
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by vp.created_at desc;
$$;

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
set search_path=public,pg_temp
as $$
  with visible_projects as (
    select p.*, access.role as list_access_role
    from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
    where true
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
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id = vp.user_id
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
set search_path=public,pg_temp
as $$
  select p.id, p.user_id::text as user_id
  from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
  where true
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
  order by p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.get_project_filter_options(
  p_user_id text,
  p_user_email text default null,
  p_workspace text default null
)
returns table (practices text[], owners jsonb)
language sql
stable
set search_path=public,pg_temp
as $$
  with visible_projects as (
    select p.user_id, nullif(trim(p.practice), '') as practice
    from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
    where true
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
        when o.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end) then 'Me'
        else coalesce(
          nullif(trim(up.display_name), ''),
          nullif(trim(up.email), ''),
          'Shared'
        )
      end as label
    from distinct_owners o
    left join public.user_profiles up
      on up.user_id = o.user_id
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
set search_path=public,pg_temp
as $$
  select
    p.id,
    p.user_id::text as user_id,
    p.name,
    p.created_at,
    p.updated_at,
    coalesce(p.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end), false) as is_owner
  from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
  where true
    and public.workspace_matches(p_workspace, p.org_id)
  order by p.updated_at desc, p.created_at desc, p.id asc
  limit greatest(coalesce(p_limit, 11), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;
