-- Migration date: 2026-10-28
--
-- Feature flags: what this deployment offers, and to whom.
--
-- The list of flags lives in code (backend/src/lib/featureFlags.ts); these
-- tables hold only what an instance admin decided. feature_flag_defaults
-- overrides a flag's code default for the whole deployment; user_feature_flags
-- overrides it for one user. A flag with no row in either table keeps its
-- code default, so a database upgraded by this migration behaves exactly as
-- before until an admin changes something in Settings → Admin.
--
-- Only the backend's service role reads or writes these rows: who is an
-- admin is decided by MIKE_ADMIN_EMAILS on the server, never by a policy a
-- browser session could satisfy.
--
-- Safe to re-run: every statement is guarded or idempotent.

create table if not exists public.feature_flag_defaults (
  flag text primary key,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.user_feature_flags (
  user_id uuid not null references auth.users(id) on delete cascade,
  flag text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint user_feature_flags_pkey primary key (user_id, flag)
);

alter table public.feature_flag_defaults enable row level security;
alter table public.user_feature_flags enable row level security;
revoke all on public.feature_flag_defaults, public.user_feature_flags from public, anon, authenticated;
grant select, insert, update, delete on public.feature_flag_defaults, public.user_feature_flags to service_role;
