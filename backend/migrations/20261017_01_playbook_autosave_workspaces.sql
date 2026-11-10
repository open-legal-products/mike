-- Migration date: 2026-10-17
-- Playbooks are continuously saved. Each review owns the exact rules it used.
alter table public.playbooks
  add column if not exists org_id uuid references public.organizations(id) on delete cascade,
  add column if not exists visibility text not null default 'private',
  add column if not exists shared_with text[] not null default '{}';
alter table public.playbooks drop constraint if exists playbooks_visibility_check;
alter table public.playbooks add constraint playbooks_visibility_check
  check (visibility in ('private', 'organization') and
    (org_id is not null or visibility = 'private') and
    (org_id is null or cardinality(shared_with) = 0));
create index if not exists idx_playbooks_org_updated on public.playbooks(org_id, updated_at desc);
create index if not exists idx_playbooks_shared_with on public.playbooks using gin(shared_with);

alter table public.playbook_runs add column if not exists content_json jsonb;
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'playbook_runs' and column_name = 'version_id') then
    update public.playbook_runs r set content_json = v.content_json
      from public.playbook_versions v where r.version_id = v.id and r.content_json is null;
  end if;
end $$;
alter table public.playbook_runs alter column content_json set not null;
alter table public.playbook_runs drop column if exists version_id;
alter table public.playbooks drop column if exists published_version_id;
alter table public.playbooks drop column if exists status;
drop table if exists public.playbook_versions;

-- Existing RLS and service-role-only table grants remain in place.
