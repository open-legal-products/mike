-- Migration date: 2026-11-01
-- Membership checks inside the per-item access verdicts compared
-- "m.user_id::text = p_user_id". Casting the column hides it from the
-- org_members (org_id, user_id) unique index, so every verdict read every
-- member of the organization. Compare the native uuid instead. The regex
-- admits exactly the canonical lowercase text a uuid casts to, so the
-- accepted inputs are unchanged: anything else still matches no member.
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
  select coalesce((case
    when not public.org_is_active(p_org_id) then null
    when exists(select 1 from public.projects where id=p_project_id and archived_at is not null) then null
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        -- An organization owner owns what is public, and what has no Owner
        -- left. A private item with an Owner is not theirs unless shared.
        when m.role = 'owner' and (
          (
            select project.visibility from public.projects project
            where project.id = p_project_id
          ) = 'organization'
          or public.project_is_ownerless(
            p_project_id, p_project_user_id, p_org_id
          )
        ) then 'owner'
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
      where m.org_id = p_org_id and m.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end), public.org_private_access_role(p_org_id,'project',p_project_id,p_user_id));
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
  select coalesce((case
    when not public.org_is_active(p_org_id) then null
    when exists(select 1 from public.workflows where id=p_workflow_id and archived_at is not null) then null
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        -- As for projects: public, or left without an Owner.
        when m.role = 'owner' and (
          (
            select workflow.visibility from public.workflows workflow
            where workflow.id = p_workflow_id
          ) = 'organization'
          or public.workflow_is_ownerless(
            p_workflow_id, p_workflow_user_id, p_org_id
          )
        ) then 'owner'
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
      where m.org_id = p_org_id and m.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
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
  end), public.org_private_access_role(p_org_id,'workflow',p_workflow_id,p_user_id));
$$;

create or replace function public.standalone_org_access_role(
  p_org_id uuid,
  p_creator_id uuid,
  p_user_id text,
  p_grant_role text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when not public.org_is_active(p_org_id) then null
    when not exists (
      select 1 from public.org_members m
      where m.org_id = p_org_id and m.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
    ) then null
    when p_creator_id::text = p_user_id then 'owner'
    else p_grant_role
  end;
$$;

create or replace function public.document_text_access(p_document_id uuid,p_user_id text,p_user_email text)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.documents d
    left join public.projects p on p.id=d.project_id
    left join public.workflows w on w.id=d.workflow_id
    where d.id=p_document_id and d.archived_at is null and public.org_is_active(d.org_id)
      and case
        when d.project_id is not null then public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) is not null
        when d.workflow_id is not null then public.workflow_access_role(w.id,w.user_id,w.org_id,p_user_id,p_user_email) is not null
        else (d.user_id::text=p_user_id and (d.org_id is null or exists(
          select 1 from public.org_members m where m.org_id=d.org_id and m.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end))))
          or public.org_private_document_access(d.org_id,d.id,p_user_id)
      end);
$$;
