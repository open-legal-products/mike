-- Migration date: 2026-10-16
-- Review edits already stamp updated_at. Starting and finishing a generation
-- (including cell regeneration/clearing) are also activity for sidebar History.
-- Keep renew_tabular_review_generation unchanged: heartbeats are not new work.
-- The claim still compares the previous version before advancing its timestamp.

create or replace function public.begin_tabular_review_generation(
  target_review_id uuid,
  expected_updated_at timestamptz,
  target_generation_id uuid,
  lease_seconds integer default 300
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_review public.tabular_reviews%rowtype;
begin
  select *
    into current_review
    from public.tabular_reviews
   where id = target_review_id
   for update;

  if not found then
    return 'not_found';
  end if;

  if current_review.active_generation_id is not null
     and current_review.generation_lease_expires_at > now() then
    return 'running';
  end if;

  if current_review.updated_at is distinct from expected_updated_at then
    return 'stale';
  end if;

  update public.tabular_reviews
     set updated_at = now(),
         active_generation_id = target_generation_id,
         generation_lease_expires_at = now()
           + make_interval(secs => greatest(60, least(lease_seconds, 3600)))
   where id = target_review_id;

  return 'started';
end;
$$;

create or replace function public.finish_tabular_review_generation(
  target_review_id uuid,
  target_generation_id uuid
)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tabular_reviews
     set updated_at = now(),
         active_generation_id = null,
         generation_lease_expires_at = null
   where id = target_review_id
     and active_generation_id = target_generation_id
  returning true;
$$;

revoke all on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.begin_tabular_review_generation(uuid, timestamptz, uuid, integer)
  to service_role;
revoke all on function public.finish_tabular_review_generation(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finish_tabular_review_generation(uuid, uuid)
  to service_role;
