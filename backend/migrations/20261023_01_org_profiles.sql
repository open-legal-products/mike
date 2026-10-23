-- Migration date: 2026-10-23
--
-- An organization's workspace profile.
--
-- A few structured facts about the organization (its name as a group, where
-- it is based and operates, its financial year, currency and structure) and
-- free text its owners and admins write for the assistant (positions it takes,
-- standing instructions). Chats in the organization's workspace receive it as
-- reference context, never as instructions or a source.
--
--   org_profiles   the profile, one per organization
--
-- The backend reads it for members and writes it for owners and admins as
-- service_role; no client role may touch it. The CHECKs repeat the API's
-- limits; the length of each jurisdiction code (at most 10) is checked by the
-- API alone, since a CHECK cannot inspect array elements without a function.
--
-- Safe to re-run: create if not exists and idempotent grants.

create table if not exists public.org_profiles (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  group_name text
    constraint org_profiles_group_name_check
    check (group_name is null or char_length(group_name) between 1 and 200),
  headquarters_jurisdiction text
    constraint org_profiles_headquarters_jurisdiction_check
    check (headquarters_jurisdiction is null
           or char_length(headquarters_jurisdiction) between 1 and 200),
  operating_jurisdictions text[] not null default '{}'
    constraint org_profiles_operating_jurisdictions_check
    check (cardinality(operating_jurisdictions) <= 100
           and array_position(operating_jurisdictions, null) is null),
  fiscal_year_end text
    constraint org_profiles_fiscal_year_end_check
    check (fiscal_year_end is null or char_length(fiscal_year_end) between 1 and 20),
  reporting_currency text
    constraint org_profiles_reporting_currency_check
    check (reporting_currency is null or reporting_currency ~ '^[A-Z]{3}$'),
  group_structure text
    constraint org_profiles_group_structure_check
    check (group_structure is null or char_length(group_structure) between 1 and 4000),
  house_positions text
    constraint org_profiles_house_positions_check
    check (house_positions is null or char_length(house_positions) between 1 and 4000),
  standing_instructions text
    constraint org_profiles_standing_instructions_check
    check (standing_instructions is null
           or char_length(standing_instructions) between 1 and 4000),
  reviewed_on date,
  -- Who saved it last. Provenance for the organization's admins; the profile
  -- outlives the account.
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.org_profiles enable row level security;

-- The backend reads and writes it as service_role; no client role may.
revoke all on public.org_profiles from anon, authenticated;
grant select, insert, update, delete on public.org_profiles to service_role;
