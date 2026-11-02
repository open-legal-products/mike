-- Migration date: 2026-10-12
--
-- Provider keys held by an organization.
--
-- Until now every provider key belonged to one person. A firm that wanted
-- its lawyers on the firm's own Anthropic or Azure account had to have each
-- of them paste the key into their own settings, and had no way to stop work
-- on its matters running on somebody's personal key instead.
--
--   org_api_keys                          one key per provider per organization
--   organizations.allow_personal_api_keys whether a member's own key may be
--                                         used for a provider the organization
--                                         has no key for
--
-- The default keeps today's behaviour: an organization with no keys and the
-- setting left on resolves keys exactly as it did before.
--
-- Safe to re-run: create/add if not exists, and grants are idempotent.

alter table public.organizations
  add column if not exists allow_personal_api_keys boolean not null default true;

-- Same shape, encryption and `settings` companion as user_api_keys, so one
-- store reads and writes both (modules/user/user.apiKeyStore.ts).
create table if not exists public.org_api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null
    constraint org_api_keys_provider_check
    check (provider in ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener')),
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  enabled boolean not null default true,
  settings jsonb constraint org_api_keys_settings_check
    check (settings is null or jsonb_typeof(settings) = 'object'),
  -- Who saved the key last. Provenance for the organization's admins; the
  -- key outlives the account.
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, provider)
);

create index if not exists idx_org_api_keys_org
  on public.org_api_keys(org_id);

alter table public.org_api_keys enable row level security;

-- The backend reads and writes it as service_role; no client role may.
revoke all on public.org_api_keys from anon, authenticated;
grant select, insert, update, delete on public.org_api_keys to service_role;
