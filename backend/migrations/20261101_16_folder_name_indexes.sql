-- Migration date: 2026-11-01
-- migrate:no-transaction
-- resolve_project_folder_path / resolve_library_folder_path look a sibling
-- up by its case- and space-insensitive name once per path segment, and
-- once per "(2)", "(3)" ... rename probe. With only (project_id) or
-- (user_id, library_kind) indexed, each lookup read every folder in the
-- project or library. Keyed by the normalized name, a lookup reads only
-- the folders of that name; the parent (matched with IS NOT DISTINCT FROM,
-- which no index can serve) and workspace are checked on those few rows.
create index concurrently if not exists project_subfolders_name_idx
  on public.project_subfolders(project_id,lower(btrim(name)));
create index concurrently if not exists library_folders_name_idx
  on public.library_folders(user_id,library_kind,lower(btrim(name)));
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('project_subfolders_name_idx','library_folders_name_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
