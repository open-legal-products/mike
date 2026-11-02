-- Migration date: 2026-10-12
--
-- An organization's own model list for each "model list" provider.
--
-- OpenRouter, Vercel AI Gateway, OpenCode Go, Bedrock, Azure OpenAI, Azure AI
-- Foundry, Vertex AI, xAI and custom endpoints only run the models somebody
-- has saved for them (user_router_models): that allowlist is what stops a
-- hand-crafted request from running an arbitrary, arbitrarily expensive
-- model on a key. Until now the list existed per person only, so an
-- organization's key for one of these providers (org_api_keys) was usable
-- by nobody who had not saved a list of their own — and the firm had no say
-- over what its key was spent on.
--
--   org_router_models            the models an organization's key may run
--   replace_org_router_models    replace one provider's list atomically
--
-- Where an organization holds the key for a provider, its list decides;
-- where a member's own key or the deployment's is used, theirs still does.
--
-- Safe to re-run: create if not exists, create or replace, idempotent grants.

create table if not exists public.org_router_models (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  router text not null
    check (router ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  model_id text not null
    check (
      model_id = btrim(model_id)
      and char_length(model_id) between 1 and 200
      and model_id !~ '\s'
    ),
  sort_order integer not null default 0 check (sort_order >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, router, model_id)
);

create index if not exists idx_org_router_models_org_router_order
  on public.org_router_models (org_id, router, sort_order, created_at);

alter table public.org_router_models enable row level security;

-- Same body as replace_user_router_models, keyed by organization: validate,
-- take an advisory lock on org+router so two overlapping saves cannot
-- interleave their delete+insert, then replace the list.
create or replace function public.replace_org_router_models(
  target_org_id uuid,
  target_router text,
  target_model_ids text[]
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if target_router !~ '^[a-z0-9][a-z0-9_-]{0,63}$' then
    raise exception 'Invalid router slug';
  end if;

  if coalesce(array_length(target_model_ids, 1), 0) > 50 then
    raise exception 'A router can have at most 50 selected models';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('org:' || target_org_id::text || ':' || target_router, 0)
  );

  delete from public.org_router_models
  where org_id = target_org_id and router = target_router;

  insert into public.org_router_models (
    org_id,
    router,
    model_id,
    sort_order
  )
  select
    target_org_id,
    target_router,
    model_id,
    ordinality - 1
  from unnest(coalesce(target_model_ids, '{}'::text[]))
    with ordinality as selected(model_id, ordinality);
end;
$$;

-- The backend reads and writes both as service_role; no client role may.
revoke all on public.org_router_models from anon, authenticated;
grant select, insert, update, delete on public.org_router_models to service_role;
revoke all on function public.replace_org_router_models(uuid, text, text[])
  from public, anon, authenticated;
grant execute
  on function public.replace_org_router_models(uuid, text, text[])
  to service_role;
