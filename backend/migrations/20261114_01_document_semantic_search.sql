-- Migration date: 2026-11-14
-- Optional semantic retrieval over stored document text (RAG).
--
-- document_version_texts already holds the complete extracted (and, with the
-- OCR patch, recognized) text of every live version. This migration adds a
-- derived, revision-bound chunk index with embeddings and a full-text vector,
-- plus a hybrid search RPC (vector + lexical, Reciprocal Rank Fusion) that
-- applies the same workspace, scope and document_text_access rules as
-- find_document_text. Nothing is queued unless the backend runs with
-- RAG_ENABLED=true: the job is created by the worker after text publication.
--
-- The embedding column is untyped `vector` so deployments can choose any
-- model/dimension. Searches compare only rows of the configured
-- embedding_model, so dimensions always match. Exact (sequential) distance is
-- computed over the caller's eligible versions only; see
-- docs/document-semantic-search.md for an optional HNSW index once a
-- deployment fixes its dimension.

create extension if not exists vector;

create table if not exists public.document_text_chunks (
  version_id uuid not null references public.document_versions(id) on delete cascade,
  source_revision uuid not null,
  embedding_model text not null,
  chunk_index integer not null,
  page_start integer,
  page_end integer,
  start_char integer not null,
  end_char integer not null,
  content text not null,
  content_tsv tsvector generated always as (to_tsvector('simple', content)) stored,
  embedding vector not null,
  created_at timestamptz not null default now(),
  primary key (version_id, embedding_model, chunk_index)
);
create index if not exists document_text_chunks_tsv_idx
  on public.document_text_chunks using gin (content_tsv);

create table if not exists public.document_embedding_status (
  version_id uuid not null references public.document_versions(id) on delete cascade,
  embedding_model text not null,
  source_revision uuid not null,
  status text not null default 'pending' check (status in ('pending','processing','ready','failed')),
  chunk_count integer,
  error_code text,
  updated_at timestamptz not null default now(),
  primary key (version_id, embedding_model)
);

alter table public.document_text_chunks enable row level security;
alter table public.document_embedding_status enable row level security;
revoke all on public.document_text_chunks, public.document_embedding_status from public, anon, authenticated;
grant select, insert, update, delete on public.document_text_chunks, public.document_embedding_status to service_role;

-- Queue embedding work for a version whose current text is ready. Idempotent:
-- an already-ready or in-flight (revision, model) pair is not queued again.
create or replace function public.queue_document_embeddings(p_version_id uuid, p_model text, p_retry_failed boolean default false)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.document_versions%rowtype; s public.document_embedding_status%rowtype;
begin
  if p_model is null or char_length(p_model) not between 1 and 200 then
    raise exception 'Invalid embedding model' using errcode='22023';
  end if;
  select * into v from public.document_versions where id=p_version_id and deleted_at is null for update;
  if not found then return false; end if;
  if not exists(select 1 from public.document_version_texts t where t.version_id=v.id
      and t.source_revision=v.text_revision and t.extractor_version=1 and t.status='ready') then
    return false;
  end if;
  select * into s from public.document_embedding_status where version_id=v.id and embedding_model=p_model;
  if found and s.source_revision=v.text_revision
     and (s.status='ready' or (s.status='failed' and not p_retry_failed)) then return false; end if;
  if exists(select 1 from public.db_jobs where dedupe_key='document.embed:'||v.id||':'||v.text_revision||':'||p_model
      and status in ('pending','running')) then return false; end if;
  insert into public.document_embedding_status(version_id,embedding_model,source_revision,status)
    values(v.id,p_model,v.text_revision,'pending')
    on conflict(version_id,embedding_model) do update set source_revision=excluded.source_revision,
      status='pending',chunk_count=null,error_code=null,updated_at=now();
  insert into public.db_jobs(kind,payload,dedupe_key,max_attempts,run_at)
    values('document.embed_text',
      jsonb_build_object('versionId',v.id,'revision',v.text_revision,'model',p_model),
      'document.embed:'||v.id||':'||v.text_revision||':'||p_model, 3, now());
  return true;
end; $$;

-- Atomically replace a version's chunks for one model, only while the text
-- revision still matches (a late job cannot publish chunks of an edited text).
create or replace function public.replace_document_text_chunks(p_version_id uuid, p_revision uuid, p_model text, p_chunks jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if jsonb_typeof(p_chunks) <> 'array' then raise exception 'Invalid chunks' using errcode='22023'; end if;
  perform 1 from public.document_versions where id=p_version_id and text_revision=p_revision and deleted_at is null for update;
  if not found then return false; end if;
  delete from public.document_text_chunks where version_id=p_version_id and embedding_model=p_model;
  insert into public.document_text_chunks(version_id,source_revision,embedding_model,chunk_index,page_start,page_end,start_char,end_char,content,embedding)
    select p_version_id,p_revision,p_model,c.chunk_index,c.page_start,c.page_end,c.start_char,c.end_char,c.content,c.embedding::vector
    from jsonb_to_recordset(p_chunks) as c(chunk_index integer,page_start integer,page_end integer,start_char integer,end_char integer,content text,embedding text);
  update public.document_embedding_status set status='ready',chunk_count=jsonb_array_length(p_chunks),error_code=null,updated_at=now()
    where version_id=p_version_id and embedding_model=p_model and source_revision=p_revision;
  return found;
end; $$;

-- Bounded backfill for versions whose text is ready but not embedded with p_model.
create or replace function public.backfill_document_embeddings(p_model text, p_limit integer default 100, p_retry_failed boolean default false)
returns integer language plpgsql security invoker set search_path=public,pg_temp as $$
declare queued integer:=0; r record;
begin
  for r in
    select v.id from public.document_versions v
      join public.documents d on d.id=v.document_id and d.archived_at is null
      join public.document_version_texts t on t.version_id=v.id and t.source_revision=v.text_revision
        and t.extractor_version=1 and t.status='ready'
      left join public.document_embedding_status s on s.version_id=v.id and s.embedding_model=p_model
    where v.deleted_at is null
      and (s.version_id is null or s.source_revision<>v.text_revision or (p_retry_failed and s.status='failed')
        -- A pending/processing row whose job already finished (for example it
        -- ran while RAG was off or another model was configured) is orphaned:
        -- requeue it when no live job exists for the same dedupe key.
        or (s.source_revision=v.text_revision and s.status in ('pending','processing')
          and not exists(select 1 from public.db_jobs j
            where j.dedupe_key='document.embed:'||v.id||':'||v.text_revision||':'||p_model
              and j.status in ('pending','running'))))
    order by (v.id=d.current_version_id) desc, v.created_at desc
    limit least(greatest(coalesce(p_limit,100),1),500)
  loop
    if public.queue_document_embeddings(r.id,p_model,p_retry_failed) then queued:=queued+1; end if;
  end loop;
  return queued;
end; $$;

-- Hybrid semantic search. Same scopes and permission checks as
-- find_document_text; only current versions; only chunks of the current
-- revision and the configured model.
create or replace function public.search_document_chunks(
  p_user_id text, p_user_email text, p_workspace text, p_scope text,
  p_query_text text, p_query_embedding text, p_model text,
  p_project_id uuid default null, p_document_id uuid default null, p_limit integer default 8
) returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare result jsonb; q vector; page_limit integer:=least(greatest(coalesce(p_limit,8),1),20);
  project_allowed boolean:=false; tsq tsquery;
begin
  if p_scope is null or p_scope not in ('project','library','templates','document')
     or p_query_text is null or char_length(trim(p_query_text))<2 or char_length(p_query_text)>2000
     or p_query_embedding is null or p_model is null
     or (p_scope='project' and p_project_id is null) or (p_scope='document' and p_document_id is null) then
    raise exception 'Invalid semantic search' using errcode='22023';
  end if;
  q:=p_query_embedding::vector;
  tsq:=websearch_to_tsquery('simple',p_query_text);
  if p_scope='project' then
    select public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) is not null
      into project_allowed from public.projects p where p.id=p_project_id;
  end if;
  with eligible as materialized (
    select d.id document_id,d.library_kind,v.id version_id,v.version_number,v.filename,v.file_type,
      v.storage_path,v.text_revision
    from public.documents d join public.document_versions v on v.id=d.current_version_id and v.deleted_at is null
    where d.archived_at is null
      and public.workspace_matches(coalesce(p_workspace,'personal'),d.org_id)
      and case p_scope
        when 'project' then d.project_id=p_project_id and coalesce(project_allowed,false)
          and public.org_is_active(d.org_id)
        when 'library' then d.project_id is null and d.workflow_id is null and d.library_kind='file'
          and d.user_id::text=p_user_id and public.document_text_access(d.id,p_user_id,p_user_email)
        when 'templates' then d.project_id is null and d.workflow_id is null and d.library_kind='template'
          and d.user_id::text=p_user_id and public.document_text_access(d.id,p_user_id,p_user_email)
        else d.id=p_document_id and public.document_text_access(d.id,p_user_id,p_user_email)
      end
  ), candidates as materialized (
    select e.*,c.chunk_index,c.page_start,c.page_end,c.start_char,c.end_char,c.content,c.embedding,c.content_tsv
    from eligible e join public.document_text_chunks c
      on c.version_id=e.version_id and c.source_revision=e.text_revision and c.embedding_model=p_model
    -- p_model is the embedding-space key (model plus configured dimensions,
    -- see embeddingClient.indexKey); this guard additionally keeps a vector
    -- of another size from ever reaching the distance operator.
    where vector_dims(c.embedding)=vector_dims(q)
  ), coverage as (
    select count(*) total_versions,
      count(*) filter (where exists(select 1 from public.document_embedding_status s where s.version_id=e.version_id
        and s.embedding_model=p_model and s.source_revision=e.text_revision and s.status='ready')) embedded_versions
    from eligible e
  ), vec as (
    select version_id,chunk_index,row_number() over (order by embedding <=> q) rnk
    from candidates order by embedding <=> q limit 60
  ), lex as (
    select version_id,chunk_index,row_number() over (order by ts_rank_cd(content_tsv,tsq) desc) rnk
    from candidates where content_tsv @@ tsq order by ts_rank_cd(content_tsv,tsq) desc limit 60
  ), fused as (
    select coalesce(vec.version_id,lex.version_id) version_id,coalesce(vec.chunk_index,lex.chunk_index) chunk_index,
      coalesce(1.0/(60+vec.rnk),0)+coalesce(1.0/(60+lex.rnk),0) score,vec.rnk vector_rank,lex.rnk lexical_rank
    from vec full join lex on lex.version_id=vec.version_id and lex.chunk_index=vec.chunk_index
    order by score desc limit page_limit
  )
  select jsonb_build_object(
    'coverage',(select to_jsonb(coverage) from coverage),
    'matches',coalesce((select jsonb_agg(jsonb_build_object(
      'document_id',c.document_id,'version_id',c.version_id,'version_number',c.version_number,
      'revision',c.text_revision,'filename',c.filename,'file_type',c.file_type,'storage_path',c.storage_path,
      'library_kind',c.library_kind,'chunk_index',c.chunk_index,'page_start',c.page_start,'page_end',c.page_end,
      'start_char',c.start_char,'end_char',c.end_char,'excerpt',c.content,
      'score',round(f.score::numeric,6),'vector_rank',f.vector_rank,'lexical_rank',f.lexical_rank
    ) order by f.score desc) from fused f join candidates c on c.version_id=f.version_id and c.chunk_index=f.chunk_index),'[]'::jsonb)
  ) into result;
  return result;
end; $$;

revoke all on function public.queue_document_embeddings(uuid,text,boolean),
  public.replace_document_text_chunks(uuid,uuid,text,jsonb),
  public.backfill_document_embeddings(text,integer,boolean),
  public.search_document_chunks(text,text,text,text,text,text,text,uuid,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.queue_document_embeddings(uuid,text,boolean),
  public.replace_document_text_chunks(uuid,uuid,text,jsonb),
  public.backfill_document_embeddings(text,integer,boolean),
  public.search_document_chunks(text,text,text,text,text,text,text,uuid,uuid,integer)
  to service_role;
