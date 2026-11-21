-- Migration date: 2026-11-01
-- The audit page's username filter tested each candidate event against
-- user_profiles. PostgreSQL ran that as one hashed pass over every profile
-- on the platform (or a probe per event). Matching profiles are now
-- resolved once, among the organization's distinct actors only. Events,
-- order and the total count are unchanged.
create or replace function public.organization_audit_events_page(
  p_org_id uuid, p_actor_id uuid, p_actor_email text,
  p_filter jsonb default '{}'::jsonb,
  p_sort_by text default 'created_at', p_sort_direction text default 'desc',
  p_offset integer default 0, p_limit integer default 50
) returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare candidates text; filtered text; result jsonb; ordering text;
begin
  if not exists(select 1 from public.active_org_members m
    where m.org_id=p_org_id and m.user_id=p_actor_id and m.role in ('owner','admin')) then
    return jsonb_build_object('events','[]'::jsonb,'total',0);
  end if;
  if p_sort_by is null or p_sort_by not in ('created_at','user_email','title','model')
    or p_sort_direction is null or p_sort_direction not in ('asc','desc') then
    raise exception 'Invalid audit sort' using errcode='22023';
  end if;
  p_limit:=greatest(1,least(coalesce(p_limit,50),2000));
  p_offset:=greatest(0,least(coalesce(p_offset,0),200000000));
  ordering:=format('%I %s nulls last, id asc',p_sort_by,p_sort_direction);
  -- Only allowlisted sort identifiers are interpolated. All filter values
  -- remain bound parameters, including arrays, search patterns and dates.
  candidates:=$query$
    select a.* from public.audit_events a where a.org_id=$1
      -- Profile matches are resolved once per call: the organization's
      -- distinct actors (an index seek per actor, as organization_audit_actors
      -- does), each profile read by its key, instead of a profile probe per
      -- event or a pass over every profile on the platform.
      and ($4->>'username_pattern' is null or a.user_email ilike $4->>'username_pattern'
        or a.user_id = any(array(
          with recursive actors as (
            (select e.user_id from public.audit_events e
              where e.org_id=$1 and e.user_id is not null order by e.user_id limit 1)
            union all
            select next_actor.user_id from actors previous cross join lateral (
              select e.user_id from public.audit_events e
              where e.org_id=$1 and e.user_id>previous.user_id order by e.user_id limit 1
            ) next_actor
          )
          select profile.user_id from actors cross join lateral (
            select p.user_id,p.display_name,p.email from public.user_profiles p where p.user_id=actors.user_id offset 0
          ) profile
          where profile.display_name ilike $4->>'username_pattern' or profile.email ilike $4->>'username_pattern')))
      and ($4->>'action' is null or a.action=$4->>'action')
      and ($4->>'status' is null or a.status=$4->>'status')
      and ($4->>'surface' is null or a.surface=$4->>'surface')
      and ($4->>'actor_user_id' is null or a.user_id=($4->>'actor_user_id')::uuid)
      and ($4->>'from' is null or a.created_at>=($4->>'from')::timestamptz)
      and ($4->>'to' is null or a.created_at<=($4->>'to')::timestamptz)
      and (not ($4 ? 'event_ids') or a.id=any(array(select jsonb_array_elements_text($4->'event_ids')::uuid)))
      and (not ($4 ? 'user_ids') or a.user_id=any(array(select jsonb_array_elements_text($4->'user_ids')::uuid)))
  $query$;
  if p_filter->>'title_pattern' is not null or p_sort_by='title' then
    -- These operations depend on visible titles, so they necessarily inspect
    -- the metadata-filtered candidates. Materialize once for both count/page.
    filtered:=format($query$
      with candidates as (%s), visible as materialized (
        select * from public.organization_audit_events($1,$2,$3,array(select id from candidates))
      ), filtered as not materialized (
        select * from visible where $4->>'title_pattern' is null or title ilike $4->>'title_pattern'
      ), page as (select * from filtered order by %s limit $5 offset $6)
      select jsonb_build_object(
        'events',coalesce((select jsonb_agg(to_jsonb(page) order by %s) from page),'[]'::jsonb),
        'total',(select count(*) from filtered))
    $query$,candidates,ordering,ordering);
  else
    -- NOT MATERIALIZED permits the count and page to use separate index scans.
    -- The expensive resource joins/permission checks see only this page's IDs.
    filtered:=format($query$
      with candidates as not materialized (%s),
      page as materialized (select id from candidates order by %s limit $5 offset $6),
      visible as (
        select * from public.organization_audit_events($1,$2,$3,array(select id from page))
      )
      select jsonb_build_object(
        'events',coalesce((select jsonb_agg(to_jsonb(visible) order by %s) from visible),'[]'::jsonb),
        'total',(select count(*) from candidates))
    $query$,candidates,ordering,ordering);
  end if;
  execute filtered into result using p_org_id,p_actor_id,p_actor_email,coalesce(p_filter,'{}'::jsonb),p_limit,p_offset;
  return result;
end;
$$;
