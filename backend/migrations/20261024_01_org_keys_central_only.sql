-- Migration date: 2026-10-24
--
-- Work inside an organization now runs only on centrally provided keys: the
-- organization's own (org_api_keys), then the deployment's. A member's
-- personal key is never used for it, and organizations no longer have a
-- setting to allow it.
--
-- The backend no longer reads organizations.allow_personal_api_keys. The
-- column stays, switched off everywhere, so a backend still on the previous
-- release during a deploy follows the same rule instead of falling back to
-- members' keys. A later migration can drop it.
--
-- Safe to re-run: the default and the update are idempotent.

alter table public.organizations
  alter column allow_personal_api_keys set default false;

update public.organizations
  set allow_personal_api_keys = false
  where allow_personal_api_keys is distinct from false;
