-- Migration date: 2026-11-01
-- migrate:no-transaction
-- Indexes for the 20261030_05 and 20261030_07 candidate lookups. A plain
-- build inside those files' transactions held a SHARE lock on the table for
-- the whole build, blocking every insert, update and delete. Built here
-- without that lock; if not exists keeps the file safe to re-run (and a no-op
-- where an earlier build of 05/07 already created them).
create index concurrently if not exists org_private_content_access_actor_kind_idx
  on public.org_private_content_access(user_id,kind,org_id,item_id);
create index concurrently if not exists workflow_shares_lower_email_idx
  on public.workflow_shares(lower(shared_with_email));
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('org_private_content_access_actor_kind_idx','workflow_shares_lower_email_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
