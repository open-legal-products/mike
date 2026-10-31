-- Migration date: 2026-10-30
-- A keyed catalogue lookup. Keep the listing function for actual listings;
-- permission checks need at most one current item, not an entire organization.
create or replace function public.org_private_content_item(p_org_id uuid,p_kind text,p_item_id uuid)
returns table(kind text,item_id uuid,title text,user_id uuid)
language sql stable set search_path=public,pg_temp as $$
  select 'project',p.id,p.name,p.user_id from public.projects p
    where p_kind='project' and p.id=p_item_id and p.org_id=p_org_id and p.archived_at is null and p.visibility='private'
  union all select 'workflow',w.id,w.title,w.user_id from public.workflows w
    where p_kind='workflow' and w.id=p_item_id and w.org_id=p_org_id and w.archived_at is null and w.visibility='private'
  union all select 'chat',c.id,c.title,c.user_id from public.chats c
    where p_kind='chat' and c.id=p_item_id and c.org_id=p_org_id and c.archived_at is null and c.project_id is null
  union all select 'tabular_review',r.id,r.title,r.user_id from public.tabular_reviews r
    where p_kind='tabular_review' and r.id=p_item_id and r.org_id=p_org_id and r.archived_at is null and r.project_id is null
  union all select 'document',d.id,coalesce(v.filename,'Untitled document'),d.user_id
    from public.documents d left join public.document_versions v on v.id=d.current_version_id and v.deleted_at is null
    where p_kind='document' and d.id=p_item_id and d.org_id=p_org_id and d.archived_at is null and d.project_id is null and d.workflow_id is null;
$$;
revoke all on function public.org_private_content_item(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.org_private_content_item(uuid,text,uuid) to service_role;

create or replace function public.org_private_access_role(p_org_id uuid,p_kind text,p_item_id uuid,p_user_id text)
returns text language sql stable set search_path=public,pg_temp as $$
  select 'viewer'::text where exists (
    select 1 from public.org_private_content_access a
    join public.org_private_content_item(p_org_id,a.kind,a.item_id) item on item.kind=a.kind and item.item_id=a.item_id
    where a.org_id=p_org_id and a.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end) and a.kind=p_kind and a.item_id=p_item_id
      and public.can_access_org_private_content(p_org_id,a.user_id)
  );
$$;

create or replace function public.org_private_document_access(p_org_id uuid,p_document_id uuid,p_user_id text)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.documents d where d.id=p_document_id and d.org_id=p_org_id
    and d.archived_at is null and (
      public.org_private_access_role(p_org_id,'document',d.id,p_user_id) is not null
      or exists(select 1 from public.org_private_content_access a
        join public.org_private_content_item(p_org_id,a.kind,a.item_id) item on item.kind=a.kind and item.item_id=a.item_id
        join public.org_item_document_ids(a.kind,a.item_id) attached on attached.document_id=d.id
        where a.org_id=p_org_id and a.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
          and public.can_access_org_private_content(p_org_id,a.user_id))
    ));
$$;

create or replace function public.list_org_private_content_access(p_org_ids uuid[],p_user_id text,p_offset integer default 0)
returns table(kind text,item_id uuid) language sql stable set search_path=public,pg_temp as $$
  select a.kind,a.item_id from public.org_private_content_access a
    join lateral public.org_private_content_item(a.org_id,a.kind,a.item_id) item on item.kind=a.kind and item.item_id=a.item_id
    where a.org_id=any(p_org_ids) and a.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
      and public.can_access_org_private_content(a.org_id,a.user_id)
    order by a.org_id,a.kind,a.item_id limit 500 offset greatest(0,p_offset);
$$;
