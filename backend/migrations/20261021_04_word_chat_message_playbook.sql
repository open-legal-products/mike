-- Migration date: 2026-10-21
-- A Word chat message can name the playbook the user attached, as a web chat
-- message already does (20261017_05), so the pill survives a reload.
alter table public.word_chat_messages add column if not exists playbook jsonb;
