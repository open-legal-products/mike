-- Migration date: 2026-10-20
-- Tavily and DeepSeek API keys for Mike's own web search are saved like the
-- Brave Search key, per user or per organization. Existing keys, RLS and
-- grants are unchanged.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;
alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener', 'brave', 'tavily', 'deepseek'));

alter table public.org_api_keys
  drop constraint if exists org_api_keys_provider_check;
alter table public.org_api_keys
  add constraint org_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener', 'brave', 'tavily', 'deepseek'));
