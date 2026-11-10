-- Migration date: 2026-10-21
-- Settings > Features > Response details: whether each response and subagent
-- shows the model, reasoning effort and token count it used. Off by default.
alter table public.user_profiles
  add column if not exists response_details_visible boolean not null default false;
