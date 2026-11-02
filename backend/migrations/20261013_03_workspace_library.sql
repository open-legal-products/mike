-- Migration date: 2026-10-13
--
-- The library, and documents uploaded on their own, belong to a workspace.
--
-- A document carried an organization only by sitting in one of its projects
-- or workflows. One uploaded to the library, or attached to a chat, was
-- personal wherever its uploader was working, so an organization's chat
-- could only ever hold personal documents, and the library was one list
-- across every workspace.
--
-- A document uploaded on its own in an organization's workspace now belongs
-- to that organization (the backend stamps documents.org_id), and so do the
-- library folders made there. Both are private to the person who made them:
-- the library shows a person their own documents for the active workspace,
-- and nobody else's.
--
--   library_folders.org_id   the workspace a folder is in; null is Personal
--   p_workspace              on the three library list functions
--   target_org_id            on resolve_library_folder_path
--
-- Like their chats and reviews there, a member's own documents in an
-- organization are deleted when they leave it; documents in a project or a
-- workflow belong to that and stay.
--
-- Safe to re-run: add column / create index if not exists, drop-before-
-- create for the constraint and the replaced function signatures.

alter table public.library_folders
  add column if not exists org_id uuid;

-- Tied to the membership, as a person's memory for a workspace is: leaving,
-- being removed and the organization being deleted all take the folder.
alter table public.library_folders
  drop constraint if exists library_folders_workspace_member_fkey;
alter table public.library_folders
  add constraint library_folders_workspace_member_fkey
  foreign key (org_id, user_id)
  references public.org_members(org_id, user_id) on delete cascade;

create index if not exists idx_library_folders_org
  on public.library_folders(org_id) where org_id is not null;

-- The three list functions take the workspace to show: null does not
-- narrow, 'personal' is documents with no organization, and an organization
-- id is that organization's (public.workspace_matches). They only ever show
-- the caller their own documents.
drop function if exists public.search_library_documents(
  text, text, integer, integer, text, text, text, text
);
create or replace function public.search_library_documents(
  p_user_id text,
  p_library_kind text,
  p_limit integer,
  p_offset integer,
  p_search_term text default null,
  p_file_type text default null,
  p_sort_key text default 'updated',
  p_sort_direction text default 'desc',
  p_workspace text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  status text,
  folder_id uuid,
  library_kind text,
  library_folder_id uuid,
  current_version_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  filename text,
  file_type text,
  storage_path text,
  pdf_storage_path text,
  size_bytes integer,
  page_count integer,
  textless_page_count integer,
  active_version_number integer
)
language sql
stable
as $$
  select
    d.id,
    d.project_id,
    d.user_id::text as user_id,
    d.status,
    d.folder_id,
    d.library_kind,
    d.library_folder_id,
    d.current_version_id,
    d.created_at,
    d.updated_at,
    coalesce(nullif(trim(v.filename), ''), 'Untitled document') as filename,
    v.file_type,
    v.storage_path,
    v.pdf_storage_path,
    v.size_bytes,
    v.page_count,
    v.textless_page_count,
    v.version_number as active_version_number
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and public.workspace_matches(p_workspace, d.org_id)
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(v.filename, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(v.filename, '')) else null end desc,
    case when p_sort_key = 'type' and p_sort_direction = 'asc' then lower(coalesce(v.file_type, '')) else null end asc,
    case when p_sort_key = 'type' and p_sort_direction = 'desc' then lower(coalesce(v.file_type, '')) else null end desc,
    case when p_sort_key = 'size' and p_sort_direction = 'asc' then coalesce(v.size_bytes, 0) else null end asc,
    case when p_sort_key = 'size' and p_sort_direction = 'desc' then coalesce(v.size_bytes, 0) else null end desc,
    case when p_sort_key = 'version' and p_sort_direction = 'asc' then coalesce(v.version_number, 0) else null end asc,
    case when p_sort_key = 'version' and p_sort_direction = 'desc' then coalesce(v.version_number, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then d.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then d.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then d.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then d.updated_at else null end desc,
    d.updated_at desc,
    d.id asc
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

drop function if exists public.get_library_filter_options(text, text);
create or replace function public.get_library_filter_options(
  p_user_id text,
  p_library_kind text,
  p_workspace text default null
)
returns table (file_types text[])
language sql
stable
as $$
  select coalesce(
    array_agg(distinct lower(v.file_type) order by lower(v.file_type))
      filter (where nullif(trim(v.file_type), '') is not null),
    array[]::text[]
  ) as file_types
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and public.workspace_matches(p_workspace, d.org_id)
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    );
$$;

drop function if exists public.get_library_document_ids(
  text, text, text, text, integer, integer
);
create or replace function public.get_library_document_ids(
  p_user_id text,
  p_library_kind text,
  p_search_term text,
  p_file_type text,
  p_limit integer,
  p_offset integer,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text
)
language sql
stable
as $$
  select d.id, d.user_id::text as user_id
  from public.documents d
  left join public.document_versions v
    on v.id = d.current_version_id
   and v.deleted_at is null
  where d.user_id::text = p_user_id
    and public.workspace_matches(p_workspace, d.org_id)
    and d.project_id is null
    and (
      (p_library_kind = 'file' and coalesce(d.library_kind, 'file') = 'file')
      or d.library_kind = p_library_kind
    )
    and (
      p_search_term is null
      or p_search_term = ''
      or lower(coalesce(v.filename, '')) like
        '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
        escape '\'
    )
    and (
      p_file_type is null
      or lower(coalesce(v.file_type, '')) = lower(p_file_type)
    )
  order by d.updated_at desc, d.id asc
  limit greatest(coalesce(p_limit, 1000), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

-- Folders are found and made within one workspace: the same name may exist
-- in Personal and in an organization, and a path never crosses between them.
drop function if exists public.resolve_library_folder_path(
  uuid, text, uuid, text[], text
);
create or replace function public.resolve_library_folder_path(
  target_user_id uuid,
  target_library_kind text,
  base_folder_id uuid,
  path_segments text[],
  conflict_resolution text default 'error',
  target_org_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  current_parent_id uuid := base_folder_id;
  folder_row public.library_folders%rowtype;
  resolved_folders jsonb := '[]'::jsonb;
  segment text;
  resolved_name text;
  first_resolved_name text;
  candidate_name text;
  suffix integer;
  segment_index integer;
begin
  if target_library_kind not in ('file', 'template') then
    raise exception 'Invalid library kind';
  end if;
  if conflict_resolution not in ('error', 'reuse', 'rename') then
    raise exception 'Invalid folder conflict resolution';
  end if;
  if coalesce(array_length(path_segments, 1), 0) = 0
     or array_length(path_segments, 1) > 100 then
    raise exception 'Folder path must contain between 1 and 100 segments';
  end if;
  if base_folder_id is not null and not exists (
    select 1 from public.library_folders
    where id = base_folder_id
      and user_id = target_user_id
      and library_kind = target_library_kind
      and org_id is not distinct from target_org_id
  ) then
    raise exception 'Parent folder not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'library-folder-path:' || target_user_id::text || ':' || target_library_kind
        || ':' || coalesce(target_org_id::text, 'personal'),
      0
    )
  );

  for segment_index in 1..array_length(path_segments, 1) loop
    segment := btrim(path_segments[segment_index]);
    if segment = '' or length(segment) > 255 then
      raise exception 'Folder names must contain between 1 and 255 characters';
    end if;
    resolved_name := segment;

    select * into folder_row
    from public.library_folders
    where user_id = target_user_id
      and library_kind = target_library_kind
      and org_id is not distinct from target_org_id
      and parent_folder_id is not distinct from current_parent_id
      and lower(btrim(name)) = lower(segment)
    order by created_at, id
    limit 1;

    if folder_row.id is not null and segment_index = 1 then
      suffix := 2;
      loop
        candidate_name := segment || ' (' || suffix || ')';
        exit when not exists (
          select 1 from public.library_folders
          where user_id = target_user_id
            and library_kind = target_library_kind
            and org_id is not distinct from target_org_id
            and parent_folder_id is not distinct from current_parent_id
            and lower(btrim(name)) = lower(candidate_name)
        );
        suffix := suffix + 1;
      end loop;

      if conflict_resolution = 'error' then
        return jsonb_build_object(
          'conflict', true,
          'folder_name', folder_row.name,
          'existing_folder_id', folder_row.id,
          'suggested_name', candidate_name
        );
      elsif conflict_resolution = 'rename' then
        folder_row := null;
        resolved_name := candidate_name;
      end if;
    end if;

    if folder_row.id is null then
      insert into public.library_folders (
        user_id, library_kind, name, parent_folder_id, org_id
      ) values (
        target_user_id, target_library_kind, resolved_name, current_parent_id,
        target_org_id
      ) returning * into folder_row;
    end if;

    if segment_index = 1 then
      first_resolved_name := folder_row.name;
    end if;
    current_parent_id := folder_row.id;
    resolved_folders := resolved_folders || jsonb_build_array(to_jsonb(folder_row));
    folder_row := null;
  end loop;

  return jsonb_build_object(
    'conflict', false,
    'folder_id', current_parent_id,
    'resolved_name', first_resolved_name,
    'folders', resolved_folders
  );
end;
$$;

revoke all on function public.resolve_library_folder_path(uuid, text, uuid, text[], text, uuid)
  from public, anon, authenticated;
grant execute on function public.resolve_library_folder_path(uuid, text, uuid, text[], text, uuid)
  to service_role;

-- What a member's leaving deletes now includes their own documents there.
create or replace function public.org_member_private_standalone(
  p_org_id uuid,
  p_user_id uuid
)
returns table (kind text, item_id uuid)
language sql
stable
set search_path = public
as $$
  select 'chat'::text, c.id
  from public.chats c
  where c.org_id = p_org_id
    and c.project_id is null
    and c.user_id = p_user_id
    and not exists (
      select 1
      from public.chat_access_grants g
      join public.user_profiles holder on lower(holder.email) = g.email
      join public.org_members m
        on m.user_id = holder.user_id and m.org_id = p_org_id
      where g.chat_id = c.id
        and g.role = 'owner'
        and holder.user_id <> p_user_id
    )
  union all
  select 'tabular_review'::text, r.id
  from public.tabular_reviews r
  where r.org_id = p_org_id
    and r.project_id is null
    and r.user_id = p_user_id
    and not exists (
      select 1
      from public.tabular_review_access_grants g
      join public.user_profiles holder on lower(holder.email) = g.email
      join public.org_members m
        on m.user_id = holder.user_id and m.org_id = p_org_id
      where g.tabular_review_id = r.id
        and g.role = 'owner'
        and holder.user_id <> p_user_id
    )
  union all
  -- Their own documents in the organization's workspace: what they uploaded
  -- to the library there or attached to a chat. One in a project or a
  -- workflow belongs to that, and stays.
  select 'document'::text, d.id
  from public.documents d
  where d.org_id = p_org_id
    and d.project_id is null
    and d.workflow_id is null
    and d.user_id = p_user_id;
$$;

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  delete from public.project_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.workflow_org_access_overrides
  where org_id = old.org_id and user_id = old.user_id;
  delete from public.chat_access_grants g
  using public.chats c, public.user_profiles holder
  where g.chat_id = c.id
    and c.org_id = old.org_id
    and c.project_id is null
    and holder.user_id = old.user_id
    and g.email = lower(holder.email);
  delete from public.tabular_review_access_grants g
  using public.tabular_reviews r, public.user_profiles holder
  where g.tabular_review_id = r.id
    and r.org_id = old.org_id
    and r.project_id is null
    and holder.user_id = old.user_id
    and g.email = lower(holder.email);
  -- Team organizations only, and only while the organization itself is
  -- staying: when it is being deleted its content has already been dealt
  -- with, and its row is gone by the time this runs.
  if public.org_is_team(old.org_id) then
    delete from public.chats c
    using public.org_member_private_standalone(old.org_id, old.user_id) gone
    where gone.kind = 'chat' and c.id = gone.item_id;
    delete from public.tabular_reviews r
    using public.org_member_private_standalone(old.org_id, old.user_id) gone
    where gone.kind = 'tabular_review' and r.id = gone.item_id;
    -- Deleting the row retires its versions, and their stored files with
    -- them (queue_document_version_cleanup).
    delete from public.documents d
    using public.org_member_private_standalone(old.org_id, old.user_id) gone
    where gone.kind = 'document' and d.id = gone.item_id;
  end if;
  return old;
end;
$$;
