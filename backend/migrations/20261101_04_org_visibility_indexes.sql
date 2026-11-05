-- Migration date: 2026-11-01
-- migrate:no-transaction
-- Membership candidates: an organization's public projects/workflows are
-- reachable by every member without touching its private ones.
create index concurrently if not exists projects_org_visibility_idx
  on public.projects(org_id,visibility) where org_id is not null;
create index concurrently if not exists workflows_org_visibility_idx
  on public.workflows(org_id,visibility) where org_id is not null;
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('projects_org_visibility_idx','workflows_org_visibility_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
