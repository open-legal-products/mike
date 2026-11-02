-- Migration date: 2026-10-14
-- Run separately from ADD CONSTRAINT so validation permits concurrent writes.
alter table public.user_profiles validate constraint user_profiles_profile_photo_check;
