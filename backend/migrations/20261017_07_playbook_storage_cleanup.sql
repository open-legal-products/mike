-- Migration date: 2026-10-17
-- Retire owned files atomically with their rows, including account and
-- organization cascades. The existing storage worker retries failed deletes.
create or replace function public.queue_playbook_storage_cleanup()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_key text := to_jsonb(old)->>tg_argv[0];
begin
  if v_key is null or v_key = '' then return null; end if;
  if tg_op = 'UPDATE' then
    if v_key is not distinct from (to_jsonb(new)->>tg_argv[0]) then
      return null;
    end if;
  end if;
  insert into public.db_jobs(kind, payload, max_attempts)
    values ('storage.cleanup', jsonb_build_object('keys', jsonb_build_array(v_key)), 8);
  return null;
end;
$$;
revoke all on function public.queue_playbook_storage_cleanup() from public, anon, authenticated;
grant execute on function public.queue_playbook_storage_cleanup() to service_role;

drop trigger if exists playbook_storage_cleanup on public.playbooks;
create trigger playbook_storage_cleanup
after delete or update of source_storage_key on public.playbooks
for each row execute function public.queue_playbook_storage_cleanup('source_storage_key');

drop trigger if exists playbook_source_storage_cleanup on public.playbook_sources;
create trigger playbook_source_storage_cleanup
after delete or update of storage_key on public.playbook_sources
for each row execute function public.queue_playbook_storage_cleanup('storage_key');
