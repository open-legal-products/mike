-- Migration date: 2026-10-18
-- What a subagent did in a chat answer, so the assistant can continue it in a
-- later turn without the subagent redoing its reading. Only the backend reads
-- or writes these rows; they expire after 30 days and go with their chat,
-- answer or account.
create table if not exists public.chat_subagent_runs (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references public.chats(id) on delete cascade,
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  delegation_id text not null check (length(delegation_id) between 1 and 100),
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null check (status in ('completed', 'incomplete', 'needs_input')),
  transcript jsonb not null check (octet_length(transcript::text) <= 400000),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  unique (chat_id, delegation_id)
);

create index if not exists chat_subagent_runs_user_expiry
  on public.chat_subagent_runs(user_id, expires_at);
create index if not exists chat_subagent_runs_message
  on public.chat_subagent_runs(message_id);

alter table public.chat_subagent_runs enable row level security;
revoke all on public.chat_subagent_runs from anon, authenticated;
grant all on public.chat_subagent_runs to service_role;
