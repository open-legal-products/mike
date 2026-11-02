-- Migration date: 2026-10-12
--
-- An organization's logo.
--
-- An organization can set a small image of its own, shown in the sidebar in
-- place of the app's logo while its workspace is active.
--
--   org_logos                      the image, one per organization
--   organizations.logo_updated_at  when it was last set, or null for none
--
-- The image sits in a table of its own, not on organizations: organizations
-- are read with `select *` in many places, and none of them should carry a
-- few hundred kilobytes of image. What they do carry is logo_updated_at,
-- which says whether there is a logo and changes when it does, so a client
-- knows when to fetch it again. A trigger keeps the two in step, in the
-- same transaction as the write.
--
-- Stored as base64 text, bounded by a CHECK: at most 512 KiB of image, which
-- is far more than the small square a client sends.
--
-- Safe to re-run: add/create if not exists, create or replace, drop-before-
-- create for the triggers, idempotent grants.

alter table public.organizations
  add column if not exists logo_updated_at timestamptz;

create table if not exists public.org_logos (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  content_type text not null
    constraint org_logos_content_type_check
    check (content_type in ('image/png', 'image/jpeg', 'image/webp')),
  -- 512 KiB of image is 699,052 base64 characters.
  data_base64 text not null
    constraint org_logos_data_size_check
    check (char_length(data_base64) between 1 and 699052),
  -- Who set it last. Provenance for the organization's admins; the logo
  -- outlives the account.
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.org_logos enable row level security;

create or replace function public.sync_org_logo_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    -- When the organization itself is being deleted this matches no row.
    update public.organizations set logo_updated_at = null
    where id = old.org_id;
    return old;
  end if;
  update public.organizations set logo_updated_at = new.updated_at
  where id = new.org_id;
  return new;
end;
$$;

drop trigger if exists org_logos_sync_updated_at on public.org_logos;
create trigger org_logos_sync_updated_at
  after insert or update or delete on public.org_logos
  for each row execute procedure public.sync_org_logo_updated_at();

-- The backend reads and writes it as service_role; no client role may.
revoke all on public.org_logos from anon, authenticated;
grant select, insert, update, delete on public.org_logos to service_role;
revoke all on function public.sync_org_logo_updated_at()
  from public, anon, authenticated;
