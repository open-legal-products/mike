-- Migration date: 2026-10-17
-- Supplementary documents a playbook's rules can refer to. Each is a copy the
-- playbook owns, so anyone who can view the playbook can read it and every
-- review sees the same text. The Word file a playbook was imported from stays
-- on public.playbooks.
create table if not exists public.playbook_sources (
  id uuid primary key default gen_random_uuid(),
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  filename text not null,
  file_type text not null,
  storage_key text not null,
  size_bytes integer not null,
  extracted_text text not null default '',
  -- Lets a review list each document's length without loading its text.
  text_length integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint playbook_sources_file_type_check check (file_type in ('docx', 'pdf')),
  constraint playbook_sources_size_check check (size_bytes > 0)
);
create index if not exists idx_playbook_sources_playbook_created
  on public.playbook_sources(playbook_id, created_at);

alter table public.playbook_sources enable row level security;
revoke all privileges on table public.playbook_sources from anon, authenticated;
grant select, insert, update, delete on public.playbook_sources to service_role;
