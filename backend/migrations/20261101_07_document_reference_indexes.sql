-- Migration date: 2026-11-01
-- migrate:no-transaction
-- Reverse document references: which chat messages and reviews name one
-- document. jsonb_path_ops serves files @> '[{"document_id":"..."}]';
-- document_ids needs the default opclass for its ? (key/element) test, and
-- no partial predicate: the planner cannot prove "document_ids is not null"
-- from a ? test against a parameter, so a partial index would go unused.
create index concurrently if not exists chat_messages_files_idx
  on public.chat_messages using gin (files jsonb_path_ops) where files is not null;
create index concurrently if not exists tabular_reviews_document_ids_idx
  on public.tabular_reviews using gin (document_ids);
-- A failed online build leaves an INVALID index that "if not exists" would
-- then skip forever. Fail loudly instead so the operator drops and re-runs it.
do $$ begin
  if exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid
    where c.relnamespace='public'::regnamespace and c.relname in ('chat_messages_files_idx','tabular_reviews_document_ids_idx') and not i.indisvalid) then
    raise exception 'An online index build left an invalid index; drop it and re-run this migration';
  end if;
end $$;
