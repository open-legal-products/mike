-- Migration date: 2026-10-14
-- Search distinct people who acted in this organization, including former
-- members. Only identities already visible in its audit log are returned.
create index if not exists audit_events_org_actor_created
  on public.audit_events(org_id, user_id, created_at desc, id desc);

create or replace function public.organization_audit_actors(
  p_org_id uuid, p_actor_id uuid, p_search text default '',
  p_offset integer default 0, p_limit integer default 21
)
returns table(user_id uuid, email text, display_name text, profile_photo text)
language sql stable set search_path = public, pg_temp as $$
  with actors as (
    select distinct on (a.user_id) a.user_id, a.user_email
    from public.audit_events a
    where a.org_id = p_org_id and a.user_id is not null and exists (
      select 1 from public.active_org_members m
      where m.org_id = p_org_id and m.user_id = p_actor_id
        and m.role in ('owner', 'admin')
    )
    order by a.user_id, a.created_at desc, a.id desc
  ), identities as (
    select a.user_id, coalesce(nullif(btrim(p.email), ''), a.user_email) as email,
      nullif(btrim(p.display_name), '') as display_name, p.profile_photo,
      a.user_email as recorded_email
    from actors a left join public.user_profiles p on p.user_id = a.user_id
  )
  select i.user_id, i.email, i.display_name, i.profile_photo from identities i
  where strpos(lower(coalesce(i.display_name, '')), lower(left(coalesce(p_search, ''), 200))) > 0
    or strpos(lower(coalesce(i.email, '')), lower(left(coalesce(p_search, ''), 200))) > 0
    or strpos(lower(coalesce(i.recorded_email, '')), lower(left(coalesce(p_search, ''), 200))) > 0
  order by lower(coalesce(i.display_name, i.email, i.user_id::text)), i.user_id
  limit greatest(0, least(coalesce(p_limit, 21), 51))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.organization_audit_actors(uuid,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.organization_audit_actors(uuid,uuid,text,integer,integer) to service_role;
