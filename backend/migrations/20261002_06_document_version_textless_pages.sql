-- Migration date: 2026-10-02
-- Record how many pages of an uploaded PDF have no text layer, so scanned PDFs
-- without OCR can be flagged in the document list. Null means not measured:
-- non-PDF files and versions created before this migration.

alter table public.document_versions
  add column if not exists textless_page_count integer;

-- Authorization remains with the calling service. These are service-role-only
-- persistence primitives; a parent lock serializes number allocation and
-- activation with deletion, including concurrent requests on different hosts.
create or replace function public.create_document_version(
  p_document_id uuid, p_version jsonb, p_activate boolean default true
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_id uuid := coalesce((p_version->>'id')::uuid, gen_random_uuid());
  v_row public.document_versions%rowtype;
  v_number integer;
begin
  perform 1 from public.documents where id = p_document_id for update;
  if not found then raise exception 'document_not_found' using errcode = 'P0002'; end if;
  select * into v_row from public.document_versions where id = v_id;
  if found then
    if v_row.document_id <> p_document_id or v_row.deleted_at is not null then
      raise exception 'version_identity_conflict' using errcode = '23505';
    end if;
    -- An upload retry must not overwrite metadata or reactivate an older
    -- version after somebody has already created a newer one.
    return to_jsonb(v_row);
  end if;
  v_number := (p_version->>'version_number')::integer;
  if v_number is null then
    select coalesce(max(version_number), 1) + 1 into v_number
    from public.document_versions
    where document_id = p_document_id
      and source in ('upload', 'user_upload', 'assistant_edit');
  end if;
  insert into public.document_versions(
    id, document_id, storage_path, pdf_storage_path, source, version_number,
    filename, file_type, size_bytes, page_count, textless_page_count,
    content_sha256
  ) values (
    v_id, p_document_id, p_version->>'storage_path', p_version->>'pdf_storage_path',
    coalesce(p_version->>'source', 'upload'), v_number,
    p_version->>'filename', p_version->>'file_type',
    (p_version->>'size_bytes')::integer, (p_version->>'page_count')::integer,
    (p_version->>'textless_page_count')::integer,
    p_version->>'content_sha256'
  ) returning * into v_row;
  if p_activate then
    update public.documents set current_version_id = v_id, updated_at = now()
      where id = p_document_id;
  end if;
  return to_jsonb(v_row);
end;
$$;
revoke all on function public.create_document_version(uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.create_document_version(uuid, jsonb, boolean) to service_role;

-- Library search returns the active version's metadata row by row, so it gains
-- the column too. Adding an output column changes the return type, which
-- `create or replace` cannot do.
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
  p_sort_direction text default 'desc'
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
