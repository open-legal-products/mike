-- Migration date: 2026-11-01
-- Batch form of wipe_memory_file for erasure loops (account and
-- organization deletion), one round trip instead of one per file. Each id
-- is wiped by wipe_memory_file itself, so locking, epoch/revision fencing,
-- validation and errors are identical; ids are taken once each, in id
-- order, so concurrent batches lock rows in the same order. The whole batch
-- is one transaction: a missing id (memory_file_not_found, P0002) or an
-- invalid source (22023) rolls back every wipe in it.
create or replace function public.wipe_memory_files(
  p_ids uuid[],
  p_enabled boolean,
  p_updated_by uuid default null,
  p_source text default 'wipe'
)
returns table(
  memory_file_id uuid,
  new_epoch bigint,
  new_revision bigint,
  effective_enabled boolean,
  mutation_at timestamptz,
  mutation_by uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  file_id uuid;
begin
  if p_source is null or p_source not in ('wipe', 'settings') then
    raise exception using errcode = '22023', message = 'invalid_memory_source';
  end if;
  for file_id in
    select distinct requested.id from unnest(coalesce(p_ids, '{}'::uuid[])) requested(id)
    order by requested.id
  loop
    return query
      select file_id, wiped.new_epoch, wiped.new_revision, wiped.effective_enabled,
        wiped.mutation_at, wiped.mutation_by
      from public.wipe_memory_file(file_id, p_enabled, p_updated_by, p_source) wiped;
  end loop;
end;
$$;
revoke all on function public.wipe_memory_files(uuid[], boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.wipe_memory_files(uuid[], boolean, uuid, text)
  to service_role;
