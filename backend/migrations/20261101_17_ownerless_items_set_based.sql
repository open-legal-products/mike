-- Migration date: 2026-11-01
-- ownerless_org_item_ids (the backend's list filters for organization
-- Owners) called project_is_ownerless / workflow_is_ownerless once per
-- private item, three subqueries each. The same conditions as anti-joins.
create or replace function public.ownerless_org_item_ids(p_org_ids uuid[])
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public
as $$
  -- project_is_ownerless / workflow_is_ownerless, written as anti-joins so
  -- the planner evaluates them for the whole set at once instead of calling
  -- a function (three subqueries) per private item. Keep the conditions in
  -- step with those functions: not archived, creator no longer a member of
  -- the item's organization, and no 'owner' override.
  select 'project'::text, p.id
  from public.projects p
  where p.org_id = any(p_org_ids)
    and p.visibility <> 'organization'
    and p.archived_at is null
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p.org_id and creator.user_id = p.user_id
    )
    and not exists (
      select 1 from public.project_org_access_overrides o
      where o.project_id = p.id and o.role = 'owner'
    )
  union all
  select 'workflow'::text, w.id
  from public.workflows w
  where w.org_id = any(p_org_ids)
    and w.visibility <> 'organization'
    and w.archived_at is null
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = w.org_id and creator.user_id = w.user_id
    )
    and not exists (
      select 1 from public.workflow_org_access_overrides o
      where o.workflow_id = w.id and o.role = 'owner'
    );
$$;
