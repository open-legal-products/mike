-- Migration date: 2026-09-12
--
-- Forward corrections to 20260904_01_organization_access.sql and
-- 20260904_02_migrate_legacy_sharing.sql. Both of those files are merged and
-- have already run on upgraded deployments, so they are not edited; every
-- fix that was drafted against them is re-expressed here so that a fresh
-- install (schema.sql) and an upgraded deployment end at the same shape.
--
-- Sequence _02 is used deliberately: 20260912_01 is claimed by the scoped
-- memory follow-up branch that has not landed yet.
--
-- Safe to re-run: every statement is guarded or idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. workflow_access_role(): compare recipient emails case-insensitively.
--
-- get_workflows_overview lists a share with lower() on both sides, while this
-- function compared the stored value raw against lower(p_user_email). A
-- legacy mixed-case row was therefore LISTED for its recipient and then 404'd
-- the moment they opened it, and re-sharing produced a second row instead of
-- updating the first. Section 4 below normalises the stored values and adds a
-- lowercase CHECK; this stays symmetrical with the overview regardless.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.workflow_access_role(p_workflow_id uuid, p_workflow_user_id uuid, p_org_id uuid, p_user_id text, p_user_email text)
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        when m.role = 'admin' then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        else 'editor'
      end
      from public.org_members m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      -- BOTH sides lowered. get_workflows_overview lists a share with
      -- lower() on both, so a legacy mixed-case row listed for its recipient
      -- and then 404'd the moment they opened it (and re-sharing produced a
      -- second row rather than updating the first). The 02 migration
      -- normalizes the stored values and adds a lowercase CHECK; this stays
      -- symmetrical with the overview regardless.
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and lower(s.shared_with_email) = lower(p_user_email)
      limit 1
    )
  end;
$function$;

-- ---------------------------------------------------------------------------
-- 2. The eight access tables are service-role only, like every other table.
--
-- RLS ENABLE with no policy is not by itself a grant boundary: `anon` and
-- `authenticated` inherit table privileges from PUBLIC unless revoked.
-- schema.sql revokes all eight for fresh installs; without these lines an
-- upgraded deployment ends up with a weaker posture than a fresh one for
-- precisely the tables that decide who can see a firm's matters. Revoking a
-- privilege that is not held is a no-op.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.organizations FROM anon, authenticated;
REVOKE ALL ON public.org_members FROM anon, authenticated;
REVOKE ALL ON public.org_invitations FROM anon, authenticated;
REVOKE ALL ON public.project_access_grants FROM anon, authenticated;
REVOKE ALL ON public.project_org_access_overrides FROM anon, authenticated;
REVOKE ALL ON public.chat_access_grants FROM anon, authenticated;
REVOKE ALL ON public.tabular_review_access_grants FROM anon, authenticated;
REVOKE ALL ON public.workflow_org_access_overrides FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Repair what the 20260904_02 backfill wrote.
--
-- 3a. A legacy shared_with array could contain the creator's own address
--     (their own invitation, echoed back). The backfill turned that into an
--     EDITOR grant on the creator's own project or review: the project reads
--     as "Shared with 1 user" and the owner appears as a guest on their own
--     matter, a state the API itself refuses to create. Remove those rows.
--     auth.users is the authoritative address; user_profiles can be missing.
-- 3b. The backfill accepted any value with an '@' anywhere, including
--     '@x.com' (no local part). Remove rows that are not addresses.
-- ---------------------------------------------------------------------------
delete from public.project_access_grants g
using public.projects p
left join public.user_profiles creator on creator.user_id = p.user_id
left join auth.users creator_auth on creator_auth.id = p.user_id
where g.project_id = p.id
  and lower(trim(g.email)) = lower(trim(coalesce(creator.email, creator_auth.email, '')))
  and coalesce(creator.email, creator_auth.email) is not null;

delete from public.tabular_review_access_grants g
using public.tabular_reviews r
left join public.user_profiles creator on creator.user_id = r.user_id
left join auth.users creator_auth on creator_auth.id = r.user_id
where g.tabular_review_id = r.id
  and lower(trim(g.email)) = lower(trim(coalesce(creator.email, creator_auth.email, '')))
  and coalesce(creator.email, creator_auth.email) is not null;

delete from public.project_access_grants
where position('@' in trim(email)) <= 1;

delete from public.tabular_review_access_grants
where position('@' in trim(email)) <= 1;

-- ---------------------------------------------------------------------------
-- 3c. Archive for direct shares on project-contained reviews.
--
-- A contained review inherits access from its project, and
-- validate_direct_access_scope refuses a review-level grant on one, so the
-- new model has no row shape for "this person may see this review and
-- nothing else in the matter". 20260904_02 dropped tabular_reviews.shared_with
-- without recording those recipients. The table below is where they belong.
--
-- On a deployment that has already run 20260904_02 the column is gone and the
-- guarded backfill is a no-op: those recipients cannot be recovered from the
-- live database, only from a pre-upgrade backup (restore shared_with into a
-- scratch column and re-run this file). The table is still created so that
-- fresh and upgraded deployments share one schema and an operator has a
-- place to record what they re-grant.
--
-- No foreign key, deliberately: this is a historical record of who lost
-- access at upgrade and it has to outlive the rows it describes.
-- ---------------------------------------------------------------------------
create table if not exists public.tabular_review_legacy_shares (
  id uuid primary key default gen_random_uuid(),
  tabular_review_id uuid not null,
  project_id uuid,
  email text not null,
  archived_at timestamptz not null default now(),
  unique(tabular_review_id, email),
  constraint tabular_review_legacy_shares_email_lowercase
    check (email = lower(email))
);

alter table public.tabular_review_legacy_shares
  drop constraint if exists tabular_review_legacy_shares_tabular_review_id_fkey;

create index if not exists idx_tabular_review_legacy_shares_review
  on public.tabular_review_legacy_shares(tabular_review_id);

alter table public.tabular_review_legacy_shares enable row level security;
revoke all on public.tabular_review_legacy_shares from anon, authenticated;
grant select, insert, update, delete
  on public.tabular_review_legacy_shares to service_role;

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'tabular_reviews'
      and column_name = 'shared_with'
  ) then
    execute $sql$
      insert into public.tabular_review_legacy_shares (
        tabular_review_id, project_id, email
      )
      select distinct
        review.id,
        review.project_id,
        lower(trim(recipient.email))
      from public.tabular_reviews review
      left join public.user_profiles creator
        on creator.user_id = review.user_id
      left join auth.users creator_auth
        on creator_auth.id = review.user_id
      cross join lateral jsonb_array_elements_text(
        case
          when jsonb_typeof(review.shared_with) = 'array'
            then review.shared_with
          else '[]'::jsonb
        end
      ) recipient(email)
      where review.project_id is not null
        and trim(recipient.email) <> ''
        and position('@' in trim(recipient.email)) > 1
        and lower(trim(recipient.email))
          is distinct from lower(trim(coalesce(
            creator.email, creator_auth.email, '')))
      on conflict (tabular_review_id, email) do nothing
    $sql$;
  end if;
end;
$migration$;

-- ---------------------------------------------------------------------------
-- 4. Canonicalise workflow share recipients the way the four sibling grant
--    tables already store them.
--
-- Collapse duplicates first, keeping the strongest role, because the unique
-- constraint on (workflow_id, shared_with_email) cannot separate 'A@x.com'
-- from 'a@x.com' once both are lowered. Ordering by role strength means a
-- recipient never LOSES access to a workflow they could already edit.
-- ---------------------------------------------------------------------------
with ranked as (
  select
    id,
    row_number() over (
      partition by workflow_id, lower(trim(shared_with_email))
      order by
        case role when 'owner' then 0 when 'editor' then 1 else 2 end,
        created_at asc,
        id asc
    ) as dup_rank
  from public.workflow_shares
)
delete from public.workflow_shares s
using ranked
where ranked.id = s.id
  and ranked.dup_rank > 1;

update public.workflow_shares
set shared_with_email = lower(trim(shared_with_email))
where shared_with_email is distinct from lower(trim(shared_with_email));

do $do$ begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'workflow_shares_email_lowercase'
      and conrelid = 'public.workflow_shares'::regclass
  ) then
    alter table public.workflow_shares
      add constraint workflow_shares_email_lowercase
      check (shared_with_email = lower(shared_with_email));
  end if;
end $do$;

notify pgrst, 'reload schema';

commit;
