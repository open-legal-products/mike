-- Migration date: 2026-11-17
-- First-run setup: on a deployment that starts with no accounts (the Vercel
-- Deploy button, docs/vercel.md), the first visitor creates the first
-- account. The claim is a single row, so two visitors racing for it cannot
-- both win, and it is offered only while auth.users is empty.

create table if not exists public.instance_setup (
  id boolean primary key default true,
  claimed_at timestamptz not null default now()
);
alter table public.instance_setup drop constraint if exists instance_setup_singleton;
alter table public.instance_setup add constraint instance_setup_singleton check (id);
alter table public.instance_setup enable row level security;
revoke all on table public.instance_setup from public, anon, authenticated;
grant select, insert, delete on table public.instance_setup to service_role;

-- True while the instance has no account and nobody has started setting it up.
create or replace function public.instance_setup_available()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not exists (select 1 from auth.users)
    and not exists (select 1 from public.instance_setup);
$$;

-- Take the one-time setup claim. Returns false when an account already
-- exists or another request holds the claim.
create or replace function public.claim_instance_setup()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from auth.users) then
    return false;
  end if;
  insert into public.instance_setup (id) values (true)
  on conflict (id) do nothing;
  return found;
end;
$$;

-- Give the claim back when creating the first account failed, so the
-- visitor can try again. Never releases once an account exists.
create or replace function public.release_instance_setup()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.instance_setup
  where not exists (select 1 from auth.users);
$$;

revoke all on function public.instance_setup_available() from public, anon, authenticated;
revoke all on function public.claim_instance_setup() from public, anon, authenticated;
revoke all on function public.release_instance_setup() from public, anon, authenticated;
grant execute on function public.instance_setup_available() to service_role;
grant execute on function public.claim_instance_setup() to service_role;
grant execute on function public.release_instance_setup() to service_role;
