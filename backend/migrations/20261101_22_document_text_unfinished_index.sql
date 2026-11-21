-- Migration date: 2026-11-01
-- migrate:no-transaction
-- backfill_document_text's work list: text rows not yet ready. Ready rows
-- (almost all of them) stay out of the index.
create index concurrently if not exists document_version_texts_unfinished_idx
  on public.document_version_texts(status,version_id) where status <> 'ready';
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('document_version_texts_unfinished_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
