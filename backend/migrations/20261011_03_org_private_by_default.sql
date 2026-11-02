-- Migration date: 2026-10-11
--
-- Make organization content private by default.
--
-- Until now every member of an organization was Editor on every one of its
-- projects and workflows unless a per-person "deny" said otherwise, and its
-- owners and admins were Owner on all of it. Sharing inside an organization
-- now works the way sharing a personal item does: nobody else can open it
-- until it is shared.
--
--   - a project or workflow is reachable by its creator, by the organization's
--     owners, and by the members it has been shared with
--   - it can be made public (visibility = 'organization'), which gives every
--     member Editor; a "deny" still walls an individual off a public item
--   - admins have no standing of their own on content, and can be shared
--     with or denied like any other member
--   - sharing never leaves the organization: every grant names a current
--     member, as the override tables' foreign keys already required
--
-- EXISTING CONTENT BECOMES PUBLIC, so nobody loses access on upgrade. Every
-- project and workflow already in an organization was open to all of its
-- members, and stays that way until an owner of the item makes it private.
--
-- Safe to re-run: the backfill only happens on the run that adds
-- workflows.visibility, so a later run cannot re-publish an item that has
-- since been made private. Everything else is drop-before-add or create or
-- replace. No function changes its signature.

-- ---------------------------------------------------------------------------
-- 1. The visibility setting, and the one-time backfill.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'workflows'
      and column_name = 'visibility'
  ) then
    alter table public.workflows
      add column visibility text not null default 'private';

    -- projects.visibility already existed but was never read, so any value
    -- it holds says nothing about who could open the project.
    update public.projects
    set visibility =
      case when org_id is not null then 'organization' else 'private' end
    where visibility is distinct from
      case when org_id is not null then 'organization' else 'private' end;

    update public.workflows
    set visibility = 'organization'
    where org_id is not null;
  end if;
end $$;

alter table public.projects
  drop constraint if exists projects_visibility_check;
alter table public.projects
  add constraint projects_visibility_check
  check (visibility in ('private', 'organization'));
alter table public.projects
  drop constraint if exists projects_visibility_scope_check;
alter table public.projects
  add constraint projects_visibility_scope_check
  check (visibility = 'private' or org_id is not null);

alter table public.workflows
  drop constraint if exists workflows_visibility_check;
alter table public.workflows
  add constraint workflows_visibility_check
  check (visibility in ('private', 'organization'));
alter table public.workflows
  drop constraint if exists workflows_visibility_scope_check;
alter table public.workflows
  add constraint workflows_visibility_scope_check
  check (visibility = 'private' or org_id is not null);

-- ---------------------------------------------------------------------------
-- 2. Role resolution, the scope label the lists show, the override guards,
--    and the list RPCs that label and filter by scope.
-- ---------------------------------------------------------------------------
create or replace function public.project_access_role(
  p_project_id uuid,
  p_project_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        when m.role = 'owner' then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        when (
          select project.visibility from public.projects project
          where project.id = p_project_id
        ) = 'organization' then 'editor'
        else null
      end
      from public.org_members m
      left join public.project_org_access_overrides o
        on o.project_id = p_project_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.project_access_scope(
  p_project_id uuid,
  p_org_id uuid,
  p_visibility text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null and p_visibility = 'organization'
      then 'organization'
    when p_org_id is not null and exists (
      select 1 from public.project_org_access_overrides o
      where o.project_id = p_project_id and o.role <> 'deny'
    ) then 'shared'
    when p_org_id is null and exists (
      select 1 from public.project_access_grants g
      where g.project_id = p_project_id
    ) then 'shared'
    else 'private'
  end;
$$;

create or replace function public.workflow_access_role(
  p_workflow_id uuid,
  p_workflow_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        when m.role = 'owner' then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        when (
          select workflow.visibility from public.workflows workflow
          where workflow.id = p_workflow_id
        ) = 'organization' then 'editor'
        else null
      end
      from public.org_members m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      -- BOTH sides lowered. get_workflows_overview lists a share with
      -- lower() on both, so a legacy mixed-case row listed for its recipient
      -- and then 404'd the moment they opened it (and re-sharing produced a
      -- second row rather than updating the first). The 02 migration
      -- normalizes the stored values and adds a lowercase CHECK; this stays
      -- symmetrical with the overview regardless.
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and lower(s.shared_with_email) = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.workflow_access_scope(
  p_workflow_id uuid,
  p_org_id uuid,
  p_visibility text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when p_org_id is not null and p_visibility = 'organization'
      then 'organization'
    when p_org_id is not null and exists (
      select 1 from public.workflow_org_access_overrides o
      where o.workflow_id = p_workflow_id and o.role <> 'deny'
    ) then 'shared'
    when p_org_id is null and exists (
      select 1 from public.workflow_shares scope_share
      where scope_share.workflow_id = p_workflow_id
    ) then 'shared'
    else 'private'
  end;
$$;

create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
declare member_role text;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id into resource_org_id, resource_creator_id
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id into resource_org_id, resource_creator_id
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  select m.role into member_role
  from public.org_members m
  where m.org_id = new.org_id and m.user_id = new.user_id
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  if member_role = 'owner' then
    raise exception 'Organization owners always have owner access'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.cleanup_org_admin_access_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.role = 'owner' then
    delete from public.project_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
    delete from public.workflow_org_access_overrides
    where org_id = new.org_id and user_id = new.user_id;
  end if;
  return new;
end;
$$;

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
as $$
  with owned as (
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
    from public.workflows w
    where w.user_id::text = p_user_id
      and public.workflow_access_role(
        w.id, w.user_id, w.org_id, p_user_id, p_user_email
      ) is not null
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
    join public.workflows w
      on w.id = ws.workflow_id
    left join public.user_profiles up
      on up.user_id::text = ws.shared_by_user_id::text
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
as $$
  with visible_projects as (
    select p.*
    from public.projects p
    where public.project_access_role(
      p.id, p.user_id, p.org_id, p_user_id, p_user_email
    ) is not null
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
            p.user_id is null
            or p.user_id::text <> p_user_id
            or public.project_access_scope(p.id, p.org_id, p.visibility) <> 'private'
          )
        )
        or (
          p_scope = 'private'
          and p.user_id::text = p_user_id
          and public.project_access_scope(p.id, p.org_id, p.visibility) = 'private'
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
          p.user_id is null
          or p.user_id::text <> p_user_id
          or public.project_access_scope(p.id, p.org_id, p.visibility) <> 'private'
        )
      )
      or (
        p_scope = 'private'
        and p.user_id::text = p_user_id
        and public.project_access_scope(p.id, p.org_id, p.visibility) = 'private'
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
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
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
      public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
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
      w.id, w.user_id::text as user_id, public.workflow_access_scope(w.id, w.org_id, w.visibility) as access_scope,
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
