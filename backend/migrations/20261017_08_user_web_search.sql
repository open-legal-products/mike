-- Migration date: 2026-10-17
-- Web search preferences from Settings > Features (whether the assistant may
-- search the web, and how for each kind of model), stored as one JSON object
-- holding only the choices that differ from the default, like response_style.
alter table public.user_profiles
  add column if not exists web_search jsonb not null default '{}'::jsonb;

alter table public.user_profiles
  drop constraint if exists user_profiles_web_search_check;
alter table public.user_profiles
  add constraint user_profiles_web_search_check
  check (
    jsonb_typeof(web_search) = 'object'
    and octet_length(web_search::text) <= 1000
  );

-- Merges a change into one user's web search settings and returns the result,
-- or null when the user has no profile. A null value in the patch removes that
-- key, which returns the setting to its default.
create or replace function public.merge_user_web_search(
  p_user_id uuid,
  p_patch jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  update public.user_profiles
     set web_search = jsonb_strip_nulls(web_search || p_patch),
         updated_at = now()
   where user_id = p_user_id
     and jsonb_typeof(p_patch) = 'object'
  returning web_search;
$$;

revoke all on function public.merge_user_web_search(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.merge_user_web_search(uuid, jsonb)
  to service_role;

-- The Brave Search API key for Mike's own web search is saved like any other
-- API key, per user or per organization. Existing keys, RLS and grants are
-- unchanged.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;
alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener', 'brave'));

alter table public.org_api_keys
  drop constraint if exists org_api_keys_provider_check;
alter table public.org_api_keys
  add constraint org_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener', 'brave'));
