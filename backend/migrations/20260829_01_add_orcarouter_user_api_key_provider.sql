-- Migration date: 2026-08-29
ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('claude', 'gemini', 'openai', 'openrouter', 'orcarouter', 'vercel', 'opencode-go', 'courtlistener'));
