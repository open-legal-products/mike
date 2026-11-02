-- Migration date: 2026-10-21
-- Defaults for subagents from Settings > Model Preferences. The assistant is
-- told them and follows them unless the conversation asks for something else.
alter table public.user_profiles
  add column if not exists subagent_model text,
  add column if not exists subagent_reasoning text;

alter table public.user_profiles
  drop constraint if exists user_profiles_subagent_reasoning_check;
alter table public.user_profiles
  add constraint user_profiles_subagent_reasoning_check
  check (subagent_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));
