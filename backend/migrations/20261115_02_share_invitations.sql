-- Migration date: 2026-11-15
-- Pending direct shares. Sharing a personal project, chat, tabular review,
-- workflow or playbook with someone outside the sharer's organizations no
-- longer writes the grant straight away: it records a pending share here,
-- addressed by normalized email, and the grant is written only when an
-- account that has CONFIRMED that address claims it. Until then the sharer
-- sees the same "Pending" entry whether or not the address has an account,
-- so sharing no longer tells anyone who uses Mike.
--
-- Shaped like org_invitations (email, role, invited_by, status, expires_at)
-- for the same reason: access addressed to an email that may not have an
-- account yet. Like an organization invitation, a pending share grants
-- NOTHING on its own.

create table if not exists public.share_invitations (
  id uuid primary key default gen_random_uuid(),
  -- Exactly one resource; each one's deletion takes its pending shares.
  project_id uuid references public.projects(id) on delete cascade,
  chat_id uuid references public.chats(id) on delete cascade,
  tabular_review_id uuid references public.tabular_reviews(id) on delete cascade,
  workflow_id uuid references public.workflows(id) on delete cascade,
  playbook_id uuid references public.playbooks(id) on delete cascade,
  email text not null,
  role text not null check (role in ('owner', 'editor', 'viewer')),
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'cancelled', 'expired')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  cancelled_at timestamptz,
  constraint share_invitations_one_resource check (
    num_nonnulls(project_id, chat_id, tabular_review_id, workflow_id, playbook_id) = 1
  ),
  constraint share_invitations_email_lowercase check (email = lower(email))
);

-- One live pending share per (resource, email). Resource ids are uuids from
-- different tables, so coalescing them cannot make two resources collide.
create unique index if not exists share_invitations_active_unique
  on public.share_invitations(
    coalesce(project_id, chat_id, tabular_review_id, workflow_id, playbook_id),
    email
  )
  where status = 'pending';
create index if not exists idx_share_invitations_email
  on public.share_invitations(email) where status = 'pending';
create index if not exists idx_share_invitations_expiry
  on public.share_invitations(expires_at) where status = 'pending';
create index if not exists idx_share_invitations_project
  on public.share_invitations(project_id) where project_id is not null;
create index if not exists idx_share_invitations_chat
  on public.share_invitations(chat_id) where chat_id is not null;
create index if not exists idx_share_invitations_review
  on public.share_invitations(tabular_review_id) where tabular_review_id is not null;
create index if not exists idx_share_invitations_workflow
  on public.share_invitations(workflow_id) where workflow_id is not null;
create index if not exists idx_share_invitations_playbook
  on public.share_invitations(playbook_id) where playbook_id is not null;
create index if not exists idx_share_invitations_invited_by
  on public.share_invitations(invited_by) where invited_by is not null;

alter table public.share_invitations enable row level security;
-- The backend reads and writes it as service_role; no client role may.
revoke all on public.share_invitations from anon, authenticated;
grant select, insert, update, delete on public.share_invitations to service_role;

-- Turn the caller's live pending shares into grants. The address comes from
-- auth.users and only once it is confirmed, the same rule requireAuth applies
-- to every email-keyed grant: an address the account has not proved it owns
-- claims nothing.
--
-- Each share is re-checked against the world as it is now, not as it was
-- when it was made: the resource must still exist, still be personal and not
-- archived, and the person who shared it must still be one of its Owners
-- (sharing is an Owner power on all five). A share that fails is cancelled,
-- never attached. Expired shares are not touched here; they never attach and
-- the maintenance sweep marks them.
--
-- Returns one row per share it resolved, so the caller can audit each.
create or replace function public.claim_share_invitations(p_user_id uuid)
returns table (
  invitation_id uuid,
  resource_kind text,
  resource_id uuid,
  email text,
  role text,
  invited_by uuid,
  outcome text
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_email text;
  v_sharer_email text;
  v_kind text;
  v_id uuid;
  v_allowed boolean;
  inv public.share_invitations%rowtype;
begin
  select lower(u.email) into v_email
  from auth.users u
  where u.id = p_user_id and u.email_confirmed_at is not null;
  if coalesce(v_email, '') = '' then
    return;
  end if;

  for inv in
    select s.* from public.share_invitations s
    where s.email = v_email
      and s.status = 'pending'
      and s.expires_at > now()
    order by s.created_at
    for update skip locked
  loop
    v_kind := case
      when inv.project_id is not null then 'project'
      when inv.chat_id is not null then 'chat'
      when inv.tabular_review_id is not null then 'tabular_review'
      when inv.workflow_id is not null then 'workflow'
      else 'playbook'
    end;
    v_id := coalesce(inv.project_id, inv.chat_id, inv.tabular_review_id,
                     inv.workflow_id, inv.playbook_id);
    v_sharer_email := null;
    if inv.invited_by is not null then
      select lower(u.email) into v_sharer_email
      from auth.users u
      where u.id = inv.invited_by and u.email_confirmed_at is not null;
    end if;

    v_allowed := inv.invited_by is not null and case v_kind
      when 'project' then exists (
        select 1 from public.projects p
        where p.id = v_id and p.org_id is null and p.archived_at is null
          and public.project_access_role(
            p.id, p.user_id, p.org_id, inv.invited_by::text, v_sharer_email
          ) = 'owner'
      )
      when 'chat' then exists (
        select 1 from public.chats c
        where c.id = v_id and c.project_id is null and c.archived_at is null
          and not public.org_is_team(c.org_id)
          and public.chat_access_role(
            c.id, c.user_id, c.project_id, c.org_id, inv.invited_by::text, v_sharer_email
          ) = 'owner'
      )
      when 'tabular_review' then exists (
        select 1 from public.tabular_reviews r
        where r.id = v_id and r.project_id is null and r.archived_at is null
          and not public.org_is_team(r.org_id)
          and public.review_access_role(
            r.id, r.user_id, r.project_id, r.org_id, inv.invited_by::text, v_sharer_email
          ) = 'owner'
      )
      when 'workflow' then exists (
        select 1 from public.workflows w
        where w.id = v_id and w.org_id is null and w.archived_at is null
          and public.workflow_access_role(
            w.id, w.user_id, w.org_id, inv.invited_by::text, v_sharer_email
          ) = 'owner'
      )
      -- Mirrors resolvePlaybookRole for a personal playbook: its creator,
      -- or someone it was shared with as Owner.
      else exists (
        select 1 from public.playbooks b
        where b.id = v_id and b.org_id is null
          and (
            b.user_id = inv.invited_by
            or (
              coalesce(v_sharer_email, '') <> ''
              and exists (
                select 1 from public.playbook_shares s
                where s.playbook_id = b.id
                  and s.shared_with_email = v_sharer_email
                  and s.role = 'owner'
              )
            )
          )
      )
    end;

    if v_allowed then
      -- A grant made since (say the recipient became a colleague and was
      -- shared with directly) is the newer decision: keep it.
      case v_kind
        when 'project' then
          insert into public.project_access_grants (project_id, email, role, created_by)
          values (v_id, inv.email, inv.role, inv.invited_by)
          on conflict (project_id, email) do nothing;
        when 'chat' then
          insert into public.chat_access_grants (chat_id, email, role, created_by)
          values (v_id, inv.email, inv.role, inv.invited_by)
          on conflict (chat_id, email) do nothing;
        when 'tabular_review' then
          insert into public.tabular_review_access_grants (tabular_review_id, email, role, created_by)
          values (v_id, inv.email, inv.role, inv.invited_by)
          on conflict (tabular_review_id, email) do nothing;
        when 'workflow' then
          insert into public.workflow_shares (workflow_id, shared_by_user_id, shared_with_email, role)
          values (v_id, inv.invited_by, inv.email, inv.role)
          on conflict (workflow_id, shared_with_email) do nothing;
        else
          insert into public.playbook_shares (playbook_id, shared_by_user_id, shared_with_email, role)
          values (v_id, inv.invited_by, inv.email, inv.role)
          on conflict (playbook_id, shared_with_email) do nothing;
      end case;
      update public.share_invitations
        set status = 'accepted', accepted_at = now()
        where id = inv.id;
    else
      update public.share_invitations
        set status = 'cancelled', cancelled_at = now()
        where id = inv.id;
    end if;

    invitation_id := inv.id;
    resource_kind := v_kind;
    resource_id := v_id;
    email := inv.email;
    role := inv.role;
    invited_by := inv.invited_by;
    outcome := case when v_allowed then 'accepted' else 'refused' end;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_share_invitations(uuid) from public, anon, authenticated;
grant execute on function public.claim_share_invitations(uuid) to service_role;
