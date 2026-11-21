-- Migration date: 2026-11-01
-- migrate:no-transaction
-- list_org_private_content pages an organization's private catalogue by
-- lower(title), item id. Each kind's catalogue rows, in that order, so a
-- page reads about offset + limit rows per kind instead of sorting them all.
create index concurrently if not exists projects_private_catalogue_idx
  on public.projects(org_id,lower(name),id) where archived_at is null and visibility = 'private';
create index concurrently if not exists workflows_private_catalogue_idx
  on public.workflows(org_id,lower(title),id) where archived_at is null and visibility = 'private';
create index concurrently if not exists chats_private_catalogue_idx
  on public.chats(org_id,lower(title),id) where archived_at is null and project_id is null;
create index concurrently if not exists tabular_reviews_private_catalogue_idx
  on public.tabular_reviews(org_id,lower(title),id) where archived_at is null and project_id is null;
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('projects_private_catalogue_idx','workflows_private_catalogue_idx','chats_private_catalogue_idx','tabular_reviews_private_catalogue_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
