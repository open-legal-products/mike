-- Migration date: 2026-10-23
-- Settings > Privacy & Data deletes data in the active workspace only.
-- "Delete all memory" used to wipe the person's memory in every workspace;
-- it now takes the workspace (null is Personal). Only the service role calls
-- it. A call that names only p_user_id still resolves, to Personal.
-- Settings' "Delete all memory" clears one workspace. With p_org_id null that
-- is Personal: the person's Personal memory and the memories of the private
-- projects they created, all-or-nothing, excluding every organization project
-- and every personal project with a direct grant. With an organization it is
-- only the person's own memory there; the organization's project memories
-- are its own, cleared from its Privacy & Data settings.
drop function if exists public.delete_user_private_memories(uuid);
create or replace function public.delete_user_private_memories(
  p_user_id uuid,
  p_org_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target record;
  deleted_projects integer := 0;
begin
  if p_org_id is not null then
    -- One file per person per workspace; none for a non-member, since the
    -- file is tied to the membership.
    for target in
      select file.id
      from public.memory_files file
      where file.scope = 'user'
        and file.user_id = p_user_id
        and file.org_id = p_org_id
    loop
      perform public.wipe_memory_file(target.id, null, p_user_id, 'wipe');
    end loop;
    return 0;
  end if;

  -- Lock the caller's own private projects rather than the whole table.
  -- FOR UPDATE on a project row blocks both a move into an organization (an
  -- UPDATE of that row) and a new access grant (the grant's foreign key takes
  -- KEY SHARE on the project, which FOR UPDATE excludes), so eligibility
  -- cannot change between this check and the wipe. A table-level SHARE lock
  -- did the same job by stalling every project write in the system for as
  -- long as this user's files took to wipe.
  perform project.id from public.projects project
  where project.user_id = p_user_id and project.org_id is null
  order by project.id
  for update;

  insert into public.memory_files(scope, user_id, enabled)
  values ('user', p_user_id, true)
  on conflict do nothing;

  for target in
    select eligible.id, eligible.scope
    from (
      -- The person's Personal memory. Their memory in each organization is
      -- that workspace's, deleted from it.
      select file.id, file.scope
      from public.memory_files file
      where file.scope = 'user'
        and file.user_id = p_user_id
        and file.org_id is null
      union all
      select file.id, file.scope
      from public.memory_files file
      join public.projects project on project.id = file.project_id
      where file.scope = 'project'
        and project.user_id = p_user_id
        and project.org_id is null
        and not exists (
          select 1 from public.project_access_grants grant_row
          where grant_row.project_id = project.id
        )
    ) eligible
    order by eligible.id
  loop
    perform public.wipe_memory_file(target.id, null, p_user_id, 'wipe');
    if target.scope = 'project' then
      deleted_projects := deleted_projects + 1;
    end if;
  end loop;

  return deleted_projects;
end;
$$;

revoke all on function public.delete_user_private_memories(uuid, uuid)
  from public, anon, authenticated;
grant execute
  on function public.delete_user_private_memories(uuid, uuid)
  to service_role;

notify pgrst, 'reload schema';
