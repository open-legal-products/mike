-- Migration date: 2026-10-02
-- Chat requests supply the browser's time zone, with UTC as the fallback.
-- Remove the redundant profile value from databases where it was added.
alter table public.user_profiles
  drop column if exists time_zone;
