-- Migration date: 2026-10-08
--
-- Move email-keyed access grants with the account when its email changes.
--
-- project_access_grants, chat_access_grants, tabular_review_access_grants and
-- workflow_shares are keyed by normalized email. handle_user_email_updated
-- used to update only the user_profiles mirror, so a confirmed address change
-- stranded every direct grant on the old address: the person lost their
-- shares, and whoever registered the old address next inherited them.
--
-- Safe to re-run: create or replace plus drop-before-create of the trigger.

create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  old_email text := lower(btrim(coalesce(old.email, '')));
  new_email text := lower(btrim(coalesce(new.email, '')));
begin
  update public.user_profiles
  set email = lower(new.email),
      updated_at = now()
  where user_id = new.id;

  -- Direct grants are keyed by normalized email, so they belong to whoever
  -- holds that address. When this account's address changes, its grants
  -- follow it: left behind, the person silently loses their shares and
  -- whoever later registers the old address (a reassigned mailbox) inherits
  -- them, Owner grants included. A grant already held by the new address is
  -- kept at the stronger of the two roles.
  if old_email = '' or old_email = new_email then
    return new;
  end if;

  if new_email = '' then
    delete from public.project_access_grants where email = old_email;
    delete from public.chat_access_grants where email = old_email;
    delete from public.tabular_review_access_grants where email = old_email;
    delete from public.workflow_shares where shared_with_email = old_email;
    return new;
  end if;

  update public.project_access_grants as kept
     set role = moved.role, updated_at = now()
    from public.project_access_grants as moved
   where moved.email = old_email
     and kept.email = new_email
     and kept.project_id = moved.project_id
     and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
       > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
  delete from public.project_access_grants as moved
   where moved.email = old_email
     and exists (
       select 1 from public.project_access_grants as kept
        where kept.project_id = moved.project_id
          and kept.email = new_email
     );
  update public.project_access_grants
     set email = new_email, updated_at = now()
   where email = old_email;

  update public.chat_access_grants as kept
     set role = moved.role, updated_at = now()
    from public.chat_access_grants as moved
   where moved.email = old_email
     and kept.email = new_email
     and kept.chat_id = moved.chat_id
     and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
       > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
  delete from public.chat_access_grants as moved
   where moved.email = old_email
     and exists (
       select 1 from public.chat_access_grants as kept
        where kept.chat_id = moved.chat_id
          and kept.email = new_email
     );
  update public.chat_access_grants
     set email = new_email, updated_at = now()
   where email = old_email;

  update public.tabular_review_access_grants as kept
     set role = moved.role, updated_at = now()
    from public.tabular_review_access_grants as moved
   where moved.email = old_email
     and kept.email = new_email
     and kept.tabular_review_id = moved.tabular_review_id
     and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
       > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
  delete from public.tabular_review_access_grants as moved
   where moved.email = old_email
     and exists (
       select 1 from public.tabular_review_access_grants as kept
        where kept.tabular_review_id = moved.tabular_review_id
          and kept.email = new_email
     );
  update public.tabular_review_access_grants
     set email = new_email, updated_at = now()
   where email = old_email;

  update public.workflow_shares as kept
     set role = moved.role
    from public.workflow_shares as moved
   where moved.shared_with_email = old_email
     and kept.shared_with_email = new_email
     and kept.workflow_id = moved.workflow_id
     and (case moved.role when 'owner' then 2 when 'editor' then 1 else 0 end)
       > (case kept.role when 'owner' then 2 when 'editor' then 1 else 0 end);
  delete from public.workflow_shares as moved
   where moved.shared_with_email = old_email
     and exists (
       select 1 from public.workflow_shares as kept
        where kept.workflow_id = moved.workflow_id
          and kept.shared_with_email = new_email
     );
  update public.workflow_shares
     set shared_with_email = new_email
   where shared_with_email = old_email;

  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute procedure public.handle_user_email_updated();
