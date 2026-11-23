-- Migration date: 2026-11-23
-- An organization's Features and Model Preferences for work in its
-- workspace. In Personal these are the person's own (user_profiles); in a
-- team organization's workspace its owners and admins set them for every
-- member. The columns mirror the user_profiles ones and default to the
-- app's defaults, so an organization that has chosen nothing behaves as a
-- person who has chosen nothing.
alter table public.organizations add column if not exists title_model text;
alter table public.organizations add column if not exists tabular_model text;
alter table public.organizations add column if not exists memory_curator_model text;
alter table public.organizations add column if not exists subagent_model text;
alter table public.organizations add column if not exists subagent_reasoning text;
alter table public.organizations
  add column if not exists quick_actions_visible boolean not null default true;
alter table public.organizations
  add column if not exists response_details_visible boolean not null default false;
alter table public.organizations
  add column if not exists web_search jsonb not null default '{}'::jsonb;

alter table public.organizations
  drop constraint if exists organizations_subagent_reasoning_check;
alter table public.organizations
  add constraint organizations_subagent_reasoning_check
  check (subagent_reasoning in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));

alter table public.organizations
  drop constraint if exists organizations_web_search_check;
alter table public.organizations
  add constraint organizations_web_search_check
  check (
    jsonb_typeof(web_search) = 'object'
    and octet_length(web_search::text) <= 1000
  );
