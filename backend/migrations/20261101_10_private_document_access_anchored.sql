-- Migration date: 2026-11-01
-- org_private_document_access (checked on every organization document read
-- and by audit redaction) joined each of the caller's opened private items to
-- that item's complete reference list, rebuilding every opened project's chat
-- message files and review rows per document checked. It now looks up the
-- few items that can carry this document and matches them to opened items
-- by primary key.
create or replace function public.org_private_document_access(p_org_id uuid,p_document_id uuid,p_user_id text)
returns boolean language sql stable set search_path=public,pg_temp as $$
  -- Anchored on the document: the items that can carry it (its project or
  -- workflow, the chats/reviews referencing it and their projects) are
  -- looked up by key, then matched against the caller's opened items by
  -- primary key. Same answer as testing the document against every opened
  -- item's full org_item_document_ids list.
  select exists(select 1 from public.documents d where d.id=p_document_id and d.org_id=p_org_id
    and d.archived_at is null and (
      public.org_private_access_role(p_org_id,'document',d.id,p_user_id) is not null
      or exists(select 1 from (
          select 'project'::text kind,d.project_id item_id
          union all select 'workflow',d.workflow_id
          union all select ref.kind,ref.item_id from public.document_referencing_items(d.id) ref
          union all select 'project',ref.project_id from public.document_referencing_items(d.id) ref
        ) holder
        join public.org_private_content_access a on a.org_id=p_org_id
          and a.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
          and a.kind=holder.kind and a.item_id=holder.item_id
        join public.org_private_content_item(p_org_id,a.kind,a.item_id) item on item.kind=a.kind and item.item_id=a.item_id
        where public.can_access_org_private_content(p_org_id,a.user_id))
    ));
$$;
