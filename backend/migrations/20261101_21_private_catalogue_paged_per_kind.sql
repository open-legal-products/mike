-- Migration date: 2026-11-01
-- list_org_private_content built the organization's whole private catalogue
-- (every standalone chat, review and document, every private project and
-- workflow), sorted it by title and kept one page. Each kind now contributes
-- only its first offset+limit rows in (lower(title), id) order, read from
-- the 20261101_20 indexes; the merged page is identical.
create or replace function public.list_org_private_content(p_org_id uuid,p_actor_id uuid,p_limit integer default 50,p_offset integer default 0,p_search text default '')
returns table(kind text,item_id uuid,title text,user_id uuid,display_name text,email text,has_access boolean)
language plpgsql stable set search_path=public,pg_temp as $$
declare page_end bigint := greatest(0,p_offset)::bigint+greatest(1,least(p_limit,101));
begin
  if not public.can_access_org_private_content(p_org_id,p_actor_id) then
    raise exception 'Private content permission required' using errcode='42501';
  end if;
  -- The catalogue of org_private_content_items, one arm per kind. The page
  -- is ordered by (lower(title), kind, item_id) and kind is constant within
  -- an arm, so the page can only contain each arm's first offset+limit rows
  -- in (lower(title), id) order: each arm stops there (index order for
  -- projects, workflows, chats and reviews) and only those are sorted.
  return query select item.kind,item.item_id,item.title,item.user_id,profile.display_name,profile.email,
    exists(select 1 from public.org_private_content_access a where a.org_id=p_org_id and a.user_id=p_actor_id and a.kind=item.kind and a.item_id=item.item_id)
    from (
      select * from (select 'project'::text kind,p.id item_id,p.name title,p.user_id
        from public.projects p
        where p.org_id=p_org_id and p.archived_at is null and p.visibility='private' and p.user_id is distinct from p_actor_id
          and (p_search='' or position(lower(p_search) in lower(coalesce(p.name,'')))>0)
        order by lower(p.name) nulls last,p.id limit page_end) project_page
      union all
      select * from (select 'workflow'::text kind,w.id item_id,w.title title,w.user_id
        from public.workflows w
        where w.org_id=p_org_id and w.archived_at is null and w.visibility='private' and w.user_id is distinct from p_actor_id
          and (p_search='' or position(lower(p_search) in lower(coalesce(w.title,'')))>0)
        order by lower(w.title) nulls last,w.id limit page_end) workflow_page
      union all
      select * from (select 'chat'::text kind,c.id item_id,c.title title,c.user_id
        from public.chats c
        where c.org_id=p_org_id and c.archived_at is null and c.project_id is null and c.user_id is distinct from p_actor_id
          and (p_search='' or position(lower(p_search) in lower(coalesce(c.title,'')))>0)
        order by lower(c.title) nulls last,c.id limit page_end) chat_page
      union all
      select * from (select 'tabular_review'::text kind,r.id item_id,r.title title,r.user_id
        from public.tabular_reviews r
        where r.org_id=p_org_id and r.archived_at is null and r.project_id is null and r.user_id is distinct from p_actor_id
          and (p_search='' or position(lower(p_search) in lower(coalesce(r.title,'')))>0)
        order by lower(r.title) nulls last,r.id limit page_end) tabular_review_page
      union all
      select * from (select 'document'::text kind,d.id item_id,coalesce(v.filename,'Untitled document') title,d.user_id
        from public.documents d left join public.document_versions v on v.id=d.current_version_id and v.deleted_at is null
        where d.org_id=p_org_id and d.archived_at is null and d.project_id is null and d.workflow_id is null and d.user_id is distinct from p_actor_id
          and (p_search='' or position(lower(p_search) in lower(coalesce(coalesce(v.filename,'Untitled document'),'')))>0)
        order by lower(coalesce(v.filename,'Untitled document')) nulls last,d.id limit page_end) document_page
    ) item left join public.user_profiles profile on profile.user_id=item.user_id
    order by lower(item.title) nulls last,item.kind,item.item_id
    limit greatest(1,least(p_limit,101)) offset greatest(0,p_offset);
end;
$$;
