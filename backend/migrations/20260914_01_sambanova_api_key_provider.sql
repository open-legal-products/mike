-- Allow users to store a personal SambaNova key.
--
-- user_api_keys.provider is gated by a check constraint, so the application
-- accepting a new provider is not enough: an insert would fail at the database
-- until the constraint knows about it.
alter table public.user_api_keys
  drop constraint if exists user_api_keys_provider_check;

alter table public.user_api_keys
  add constraint user_api_keys_provider_check
  check (provider in ('claude', 'gemini', 'openai', 'openrouter', 'vercel', 'opencode-go', 'sambanova', 'courtlistener'));
