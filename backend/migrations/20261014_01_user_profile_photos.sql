-- Migration date: 2026-10-14
-- Small raster avatars use the existing private profile and its grants.
alter table public.user_profiles add column if not exists profile_photo text;
alter table public.user_profiles drop constraint if exists user_profiles_profile_photo_check;
alter table public.user_profiles add constraint user_profiles_profile_photo_check
  check (profile_photo is null or (
    octet_length(profile_photo) <= 699116
    and profile_photo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'
  )) not valid;
-- Validate in the next migration so this transaction releases its stronger
-- table lock before existing rows are scanned.
