-- Migration date: 2026-10-07
-- Preserve existing keys and RLS while allowing encrypted Mistral credentials.
ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'courtlistener'));
