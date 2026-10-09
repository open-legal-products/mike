-- Migration date: 2026-10-08
-- Allow encrypted Amazon Bedrock and Azure OpenAI credentials, and store the
-- non-secret setting each of those keys needs (the AWS region a Bedrock key
-- belongs to, the Azure OpenAI resource an Azure key belongs to) next to the
-- key so the two are always saved, replaced and removed together. Existing
-- keys, RLS and grants are unchanged.
ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'courtlistener'));

ALTER TABLE public.user_api_keys
  ADD COLUMN IF NOT EXISTS settings jsonb;

ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_settings_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_settings_check
  CHECK (settings IS NULL OR jsonb_typeof(settings) = 'object');
