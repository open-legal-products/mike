-- Migration date: 2026-10-09
-- Allow encrypted Google Vertex AI, Azure AI Foundry, xAI and custom
-- OpenAI-compatible endpoint credentials. The non-secret companion setting of
-- each (a Vertex AI location, a Foundry endpoint, an endpoint base URL) is
-- stored in the existing settings column. Existing keys, RLS and grants are
-- unchanged.
ALTER TABLE public.user_api_keys
  DROP CONSTRAINT IF EXISTS user_api_keys_provider_check;

ALTER TABLE public.user_api_keys
  ADD CONSTRAINT user_api_keys_provider_check
  CHECK (provider IN ('claude', 'gemini', 'openai', 'mistral', 'openrouter', 'vercel', 'opencode-go', 'bedrock', 'azure', 'azure-foundry', 'vertex', 'xai', 'custom', 'courtlistener'));
