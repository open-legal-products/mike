-- Migration date: 2026-10-23
--
-- Whether an organization's members may export, or bulk-delete, their own
-- work in it from Settings > Privacy & Data.
--
--   organizations.allow_member_exports  "Export chats / tabular reviews /
--                                        account JSON / memory" in the
--                                        organization's workspace
--   organizations.allow_member_deletes  "Delete all chats / tabular reviews /
--                                        projects / memory" there
--
-- Both start off: a firm's work leaves, or is erased in bulk, only once its
-- owners allow it. Owners themselves are never held back by either. Deleting
-- one chat or project at a time is not affected.
--
-- Safe to re-run: add column if not exists.

alter table public.organizations
  add column if not exists allow_member_exports boolean not null default false;

alter table public.organizations
  add column if not exists allow_member_deletes boolean not null default false;
