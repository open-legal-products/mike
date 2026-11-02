-- Migration date: 2026-10-02
-- Free-form custom instructions a user writes in Settings > Personalisation.
-- They are added to the system prompt of every assistant conversation.
alter table public.user_profiles
  add column if not exists custom_instructions text not null default '';

alter table public.user_profiles
  drop constraint if exists user_profiles_custom_instructions_length;
alter table public.user_profiles
  add constraint user_profiles_custom_instructions_length
  check (char_length(custom_instructions) <= 8000);
