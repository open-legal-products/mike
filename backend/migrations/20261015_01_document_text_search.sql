-- Migration date: 2026-10-15
-- Text is derived from one revision of one version. Version ids may survive
-- editor saves and tracked-change resolution, so they are not cache identities.
-- A constant initial revision uses PostgreSQL's metadata-only column default.
-- Cache/job identities include version_id, so legacy versions may safely share it.
-- New versions and subsequent content edits receive a fresh random revision.
alter table public.document_versions add column if not exists text_revision uuid not null
  default '00000000-0000-0000-0000-000000000000'::uuid;
alter table public.document_versions alter column text_revision set default gen_random_uuid();
create table if not exists public.document_version_texts (
  version_id uuid primary key references public.document_versions(id) on delete cascade,
  source_revision uuid not null,
  extractor_version integer not null default 1,
  status text not null default 'pending' check (status in ('pending','processing','ready','failed')),
  text_content text,
  source_sha256 text,
  textless_page_count integer,
  error_code text,
  updated_at timestamptz not null default now(),
  constraint document_version_texts_ready check ((status = 'ready') = (text_content is not null))
);
alter table public.document_version_texts enable row level security;
revoke all on public.document_version_texts from public, anon, authenticated;
grant select,insert,update,delete on public.document_version_texts to service_role;
create extension if not exists pg_trgm;
-- Managed Supabase may install extensions outside public.
do $$
declare extension_schema text;
begin
  select n.nspname into extension_schema from pg_extension e
    join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_trgm';
  execute format('create index if not exists document_version_texts_find_idx on public.document_version_texts using gin (lower(text_content) %I.gin_trgm_ops) where status = %L',extension_schema,'ready');
end;
$$;

create or replace function public.queue_document_text(p_version_id uuid, p_retry_failed boolean default false)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.document_versions%rowtype; t public.document_version_texts%rowtype;
begin
  select * into v from public.document_versions where id=p_version_id and deleted_at is null and storage_path is not null for update;
  if not found then return false; end if;
  select * into t from public.document_version_texts where version_id=v.id;
  if t.source_revision=v.text_revision and t.extractor_version=1 and
    (t.status='ready' or (t.status='failed' and not p_retry_failed)) then return false; end if;
  if exists(select 1 from public.db_jobs where dedupe_key='document.text:'||v.id||':'||v.text_revision
    and status in ('pending','running')) then return false; end if;
  insert into public.document_version_texts(version_id,source_revision)
    values(v.id,v.text_revision)
    on conflict(version_id) do update set source_revision=excluded.source_revision,
      extractor_version=1,status='pending',text_content=null,source_sha256=null,
      textless_page_count=null,error_code=null,updated_at=now();
  insert into public.db_jobs(kind,payload,dedupe_key,max_attempts,run_at)
    values('document.extract_text',jsonb_build_object('versionId',v.id,'revision',v.text_revision),
      'document.text:'||v.id||':'||v.text_revision,3,now()+interval '2 seconds')
    on conflict do nothing;
  return true;
end;
$$;

create or replace function public.document_text_revision_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.storage_path is distinct from old.storage_path
    or new.content_sha256 is distinct from old.content_sha256
    or new.file_type is distinct from old.file_type
    or new.deleted_at is distinct from old.deleted_at then
    new.text_revision := gen_random_uuid();
  else
    -- Do not permit metadata-only writes to forge a cache revision.
    new.text_revision := old.text_revision;
  end if;
  return new;
end;
$$;
create or replace function public.document_text_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.deleted_at is not null or new.storage_path is null then
    delete from public.document_version_texts where version_id=new.id;
  elsif tg_op='INSERT' or new.text_revision is distinct from old.text_revision then
    perform public.queue_document_text(new.id);
  end if;
  return new;
end;
$$;
drop trigger if exists document_text_revision_changed on public.document_versions;
create trigger document_text_revision_changed before update on public.document_versions
  for each row execute function public.document_text_revision_changed();
drop trigger if exists document_text_changed on public.document_versions;
create trigger document_text_changed after insert or update on public.document_versions
  for each row execute function public.document_text_changed();

-- Bounded and resumable: rows/jobs themselves are the checkpoint. Prioritize
-- active versions, then history. Failed rows require an explicit retry request.
create or replace function public.backfill_document_text(p_limit integer default 100, p_retry_failed boolean default false)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare row record; queued integer := 0;
begin
  for row in
    select v.id from public.document_versions v join public.documents d on d.id=v.document_id
    left join public.document_version_texts t on t.version_id=v.id
    where v.deleted_at is null and v.storage_path is not null and d.archived_at is null
      and (t.version_id is null or t.source_revision<>v.text_revision or t.extractor_version<>1
        or t.status in ('pending','processing') or (p_retry_failed and t.status='failed'))
      and not exists(select 1 from public.db_jobs j where j.dedupe_key='document.text:'||v.id||':'||v.text_revision
        and j.status in ('pending','running'))
    order by (v.id=d.current_version_id) desc, v.id
    limit least(greatest(coalesce(p_limit,100),1),500)
    for update of v skip locked
  loop
    if public.queue_document_text(row.id,p_retry_failed) then queued:=queued+1; end if;
  end loop;
  return queued;
end;
$$;

-- Lock in the same order as the lifecycle trigger. An obsolete job can never
-- publish after a newer save, including replacement of bytes within one version.
create or replace function public.publish_document_text(p_version_id uuid,p_revision uuid,p_text text,p_sha256 text,p_textless_pages integer)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  perform 1 from public.document_versions where id=p_version_id and text_revision=p_revision and deleted_at is null for update;
  if not found then return false; end if;
  update public.document_version_texts set status='ready',text_content=p_text,
    source_sha256=p_sha256,textless_page_count=p_textless_pages,error_code=null,updated_at=now()
    where version_id=p_version_id and source_revision=p_revision and extractor_version=1;
  return found;
end;
$$;

-- Server-only policy shared by find and read; counts and snippets use exactly
-- the same permissions. Organization membership/denials are evaluated live.
create or replace function public.document_text_access(p_document_id uuid,p_user_id text,p_user_email text)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.documents d
    left join public.projects p on p.id=d.project_id
    left join public.workflows w on w.id=d.workflow_id
    where d.id=p_document_id and d.archived_at is null and public.org_is_active(d.org_id)
      and case
        when d.project_id is not null then public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) is not null
        when d.workflow_id is not null then public.workflow_access_role(w.id,w.user_id,w.org_id,p_user_id,p_user_email) is not null
        else (d.user_id::text=p_user_id and (d.org_id is null or exists(
          select 1 from public.org_members m where m.org_id=d.org_id and m.user_id::text=p_user_id)))
          or public.org_private_document_access(d.org_id,d.id,p_user_id)
      end);
$$;

-- Literal, case-insensitive matching. %, _, backslashes and regex syntax are
-- data. Offsets are zero-based Unicode character offsets into extracted text.
create or replace function public.find_document_text(
  p_user_id text,p_user_email text,p_workspace text,p_scope text,p_query text,
  p_project_id uuid default null,p_document_id uuid default null,p_version_id uuid default null,
  p_limit integer default 10,p_offset integer default 0
) returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare result jsonb; page_limit integer:=least(greatest(coalesce(p_limit,10),1),20);
begin
  if p_scope is null or p_scope not in ('project','library','templates','document') or p_query is null
    or char_length(trim(p_query))<2 or char_length(p_query)>500
    or p_offset is null or p_offset<0 or p_offset>100000
    or (p_scope='project' and p_project_id is null)
    or (p_scope='document' and p_document_id is null)
    or (p_version_id is not null and p_scope<>'document') then
    raise exception 'Invalid document search' using errcode='22023';
  end if;
  with eligible as materialized (
    select d.id document_id,d.library_kind,v.id version_id,v.version_number,v.filename,v.file_type,
      v.storage_path,v.text_revision
    from public.documents d join public.document_versions v on v.document_id=d.id
    where d.archived_at is null and v.deleted_at is null
      and (case when p_version_id is null then v.id=d.current_version_id else v.id=p_version_id end)
      and public.workspace_matches(coalesce(p_workspace,'personal'),d.org_id)
      and case p_scope
        when 'project' then d.project_id=p_project_id
        when 'library' then d.project_id is null and d.workflow_id is null and d.library_kind='file' and d.user_id::text=p_user_id
        when 'templates' then d.project_id is null and d.workflow_id is null and d.library_kind='template' and d.user_id::text=p_user_id
        when 'document' then d.id=p_document_id
        else false end
      and public.document_text_access(d.id,p_user_id,p_user_email)
  ), coverage as (
    select count(*) total_versions,
      count(*) filter(where t.status='ready') indexed_versions,
      count(*) filter(where t.status='failed') failed_versions,
      count(*) filter(where t.status is null or t.status in ('pending','processing')) pending_versions,
      count(*) filter(where t.status='ready' and t.textless_page_count>0) versions_needing_ocr
    from eligible e left join public.document_version_texts t
      on t.version_id=e.version_id and t.source_revision=e.text_revision and t.extractor_version=1
  ), hits as (
    select e.*,t.text_content,strpos(lower(t.text_content),lower(p_query)) pos
    from public.document_version_texts t join eligible e on e.version_id=t.version_id and e.text_revision=t.source_revision
    where t.status='ready' and t.extractor_version=1 and lower(t.text_content) like
      '%'||replace(replace(replace(lower(p_query),'\','\\'),'%','\%'),'_','\_')||'%' escape '\'
    order by e.document_id,e.version_id limit page_limit+1 offset p_offset
  ), page as (
    select * from hits order by document_id,version_id limit page_limit
  )
  select jsonb_build_object('coverage',(select to_jsonb(coverage) from coverage),
    'next_offset',case when (select count(*) from hits)>page_limit then p_offset+page_limit else null end,
    'matches',coalesce((select jsonb_agg(jsonb_build_object(
      'document_id',document_id,'version_id',version_id,'version_number',version_number,
      'revision',text_revision,'filename',filename,'file_type',file_type,'storage_path',storage_path,
      'library_kind',library_kind,'start_char',pos-1,'end_char',pos-1+char_length(p_query),
      'excerpt_start_char',greatest(pos-161,0),
      'excerpt',substring(text_content from greatest(pos-160,1) for char_length(p_query)+320)
    ) order by document_id,version_id) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;

create or replace function public.read_document_text(p_user_id text,p_user_email text,p_document_id uuid,p_version_id uuid)
returns jsonb language sql stable security invoker set search_path=public,pg_temp as $$
  select jsonb_build_object('revision',v.text_revision,'status',coalesce(t.status,'pending'),
    'text',t.text_content,'textless_page_count',t.textless_page_count)
  from public.document_versions v left join public.document_version_texts t
    on t.version_id=v.id and t.source_revision=v.text_revision and t.extractor_version=1
  where v.id=p_version_id and v.document_id=p_document_id and v.deleted_at is null
    and public.document_text_access(p_document_id,p_user_id,p_user_email);
$$;

revoke all on function public.queue_document_text(uuid,boolean),public.document_text_revision_changed(),public.document_text_changed(),
  public.backfill_document_text(integer,boolean),public.publish_document_text(uuid,uuid,text,text,integer),
  public.document_text_access(uuid,text,text),public.find_document_text(text,text,text,text,text,uuid,uuid,uuid,integer,integer),
  public.read_document_text(text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.queue_document_text(uuid,boolean),public.backfill_document_text(integer,boolean),
  public.publish_document_text(uuid,uuid,text,text,integer),public.document_text_access(uuid,text,text),
  public.find_document_text(text,text,text,text,text,uuid,uuid,uuid,integer,integer),
  public.read_document_text(text,text,uuid,uuid) to service_role;

-- Queue only a bounded first batch. The maintenance sweep resumes the rest.
select public.backfill_document_text(100,false);
