-- Migration date: 2026-10-13
-- The archive as the Departed members view lists it: every unexpired item
-- with whose it was and what a project or workflow holds, in one read that
-- rechecks the caller is an owner. A deleted account leaves no profile, so
-- its name and email come back null. Safe to re-run.

create or replace function public.list_org_departure_work(p_org_id uuid,p_actor_id uuid,p_limit integer default 2001)
returns table(id uuid,kind text,item_id uuid,title text,archived_at timestamptz,expires_at timestamptz,
  former_user_id uuid,former_display_name text,former_email text,documents integer,chats integer,tabular_reviews integer)
language sql stable set search_path = public as $$
  select a.id,a.kind,a.item_id,a.title,a.archived_at,a.expires_at,a.former_user_id,p.display_name,p.email,
    case a.kind when 'project' then (select count(*)::integer from public.documents d where d.project_id=a.item_id)
      when 'workflow' then (select count(*)::integer from public.documents d where d.workflow_id=a.item_id) end,
    case when a.kind='project' then (select count(*)::integer from public.chats c where c.project_id=a.item_id) end,
    case when a.kind='project' then (select count(*)::integer from public.tabular_reviews r where r.project_id=a.item_id) end
  from public.org_departure_archives a
  left join public.user_profiles p on p.user_id=a.former_user_id
  where a.org_id=p_org_id and a.expires_at>now()
    and exists(select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=p_actor_id and m.role='owner')
  order by a.expires_at,a.archived_at,a.id limit greatest(1,least(p_limit,5001));
$$;
revoke all on function public.list_org_departure_work(uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.list_org_departure_work(uuid,uuid,integer) to service_role;
