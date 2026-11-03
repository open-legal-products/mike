-- Migration date: 2026-11-02
-- Project brief state is identity-bound, never inferred from a filename.
create table if not exists public.project_reviewed_briefs (
  project_id uuid primary key references public.projects(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  accepted_snapshot jsonb,
  accepted_content jsonb,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);
-- A moved document can be designated in its new project while the old
-- project retains its historical binding. Current project membership, not global
-- document uniqueness, determines the active designation.
alter table public.project_reviewed_briefs drop constraint if exists project_reviewed_briefs_document_id_key;
create index if not exists project_reviewed_briefs_document_idx on public.project_reviewed_briefs(document_id);
create table if not exists public.project_brief_proposals (
  id uuid primary key,
  project_id uuid not null references public.project_reviewed_briefs(project_id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  base jsonb not null,
  sources jsonb not null,
  content jsonb not null,
  before_text text not null,
  gaps jsonb not null,
  staged_version jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour',
  applied_version_id uuid references public.document_versions(id) on delete set null,
  applied_at timestamptz
);
create table if not exists public.project_brief_reviews (
  proposal_id uuid not null references public.project_brief_proposals(id) on delete cascade,
  project_id uuid not null references public.project_reviewed_briefs(project_id) on delete cascade,
  source jsonb not null,
  primary key (proposal_id, source)
);
create index if not exists project_brief_proposals_project_idx on public.project_brief_proposals(project_id);
do $$ declare t text; begin
  foreach t in array array['project_reviewed_briefs','project_brief_proposals','project_brief_reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public,anon,authenticated', t);
    execute format('grant select,insert,update,delete on public.%I to service_role', t);
  end loop;
end $$;

-- Internal service-only snapshot. The extractor's revision AND byte hash must
-- match; a pending/partial/empty extraction cannot become reviewed evidence.
create or replace function public.project_brief_source(p_document_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object(
    'documentId',d.id,'versionId',v.id,'revision',v.text_revision,
    'hash',v.content_sha256,'storagePath',v.storage_path,'filename',v.filename,
    'fileType',v.file_type,'sizeBytes',v.size_bytes,
    'textHash',case when t.text_content is not null then encode(sha256(convert_to(t.text_content,'UTF8')),'hex') end,
    'ready',coalesce(t.status='ready' and t.source_revision=v.text_revision
      and t.extractor_version=1 and t.source_sha256=v.content_sha256
      and v.content_sha256 is not null and v.storage_path is not null
      and length(trim(t.text_content))>0 and length(t.text_content)<=100000
      and coalesce(t.textless_page_count,0)=0,false),
    'reason',case
      when v.content_sha256 is null then 'Byte fingerprint unavailable'
      when t.source_revision is distinct from v.text_revision or t.source_sha256 is distinct from v.content_sha256 then 'Extraction is stale or pending'
      when t.status is distinct from 'ready' then 'Text extraction is not ready'
      when coalesce(t.textless_page_count,0)>0 then 'Some pages have no extracted text'
      when length(trim(t.text_content))=0 then 'No readable text'
      when length(t.text_content)>100000 then 'Text exceeds this review limit'
      else null end)
  from public.documents d join public.document_versions v on v.id=d.current_version_id and v.document_id=d.id
  left join public.document_version_texts t on t.version_id=v.id
  where d.id=p_document_id and d.archived_at is null and v.deleted_at is null;
$$;

create or replace function public.project_brief_access(p_project_id uuid,p_actor_id uuid,p_actor_email text,p_write boolean)
returns text language plpgsql security invoker set search_path='' as $$
declare p public.projects%rowtype; role text;
begin
  select * into p from public.projects where id=p_project_id and archived_at is null;
  if not found then raise exception 'brief_not_found' using errcode='P0002'; end if;
  role:=public.project_access_role(p.id,p.user_id,p.org_id,p_actor_id::text,p_actor_email);
  if role is null then raise exception 'brief_not_found' using errcode='P0002'; end if;
  if p_write and role not in ('owner','editor') then raise exception 'brief_read_only' using errcode='42501'; end if;
  return role;
end $$;

create or replace function public.project_brief_bundle(p_project_id uuid,p_actor_id uuid,p_actor_email text,p_selected uuid[] default '{}')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b public.project_reviewed_briefs%rowtype; s jsonb; snapshots jsonb; role text;
begin
  role:=public.project_brief_access(p_project_id,p_actor_id,p_actor_email,false);
  if (select count(*) from public.documents where project_id=p_project_id and archived_at is null)>500 then
    raise exception 'brief_project_limit' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_selected) selected(document_id) where not exists(
    select 1 from public.documents d where d.id=selected.document_id and d.project_id=p_project_id and d.archived_at is null)) then
    raise exception 'brief_not_found' using errcode='P0002'; end if;
  select * into b from public.project_reviewed_briefs where project_id=p_project_id;
  select coalesce(jsonb_agg(x.snapshot order by x.document_id),'[]') into snapshots from (
    select d.id document_id, coalesce(public.project_brief_source(d.id),jsonb_build_object('documentId',d.id,'versionId','','revision','','hash','','textHash','','filename','Document awaiting version','ready',false,'reason','No active readable version')) || jsonb_build_object(
      'reviewed',exists(select 1 from public.project_brief_reviews r where r.project_id=p_project_id
        and r.source=public.project_brief_source(d.id) and exists(select 1 from public.project_brief_proposals reviewed_proposal where reviewed_proposal.id=r.proposal_id and reviewed_proposal.base->>'documentId'=b.document_id::text)),
      'text',case when d.id=b.document_id or d.id=any(p_selected) then
        (select t.text_content from public.document_version_texts t where t.version_id=d.current_version_id) end
    ) snapshot from public.documents d where d.project_id=p_project_id and d.archived_at is null
  ) x where x.snapshot is not null;
  s:=case when exists(select 1 from public.documents where id=b.document_id and project_id=p_project_id and archived_at is null) then public.project_brief_source(b.document_id) else null end;
  return jsonb_build_object('brief',s,'accepted',b.accepted_snapshot,'acceptedContent',b.accepted_content,
    'pendingProposalId',(select q.id from public.project_brief_proposals q where q.project_id=p_project_id and q.actor_id=p_actor_id and q.applied_at is null and q.expires_at>now() and s is not null and q.base=s and not exists(select 1 from jsonb_array_elements(q.sources) source_row(value) where source_row.value is distinct from public.project_brief_source((source_row.value->>'documentId')::uuid)) order by q.created_at desc limit 1),
    'acceptedEvidence',coalesce((select jsonb_build_array(q.base)||q.sources from public.project_brief_proposals q where q.project_id=p_project_id and q.applied_version_id=(b.accepted_snapshot->>'versionId')::uuid order by q.applied_at desc limit 1),'[]'::jsonb),
    'acceptedAt',b.accepted_at,'canEdit',role in ('owner','editor'),'sources',snapshots);
end $$;

create or replace function public.project_brief_designate(p_project_id uuid,p_actor_id uuid,p_actor_email text,p_document_id uuid)
returns void language plpgsql security invoker set search_path='' as $$
declare s jsonb;
begin
  perform 1 from public.projects where id=p_project_id for update;
  perform public.project_brief_access(p_project_id,p_actor_id,p_actor_email,true);
  perform 1 from public.documents where id=p_document_id and project_id=p_project_id and archived_at is null for update;
  if not found then raise exception 'brief_not_found' using errcode='P0002'; end if;
  s:=public.project_brief_source(p_document_id);
  if s is null or lower(coalesce(s->>'fileType','')) not in ('docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    then raise exception 'brief_requires_docx' using errcode='22023'; end if;
  insert into public.project_reviewed_briefs(project_id,document_id) values(p_project_id,p_document_id)
    on conflict(project_id) do update set document_id=excluded.document_id,
      accepted_snapshot=null,accepted_content=null,accepted_at=null,accepted_by=null
    where not exists(select 1 from public.documents old_brief where old_brief.id=project_reviewed_briefs.document_id and old_brief.project_id=p_project_id and old_brief.archived_at is null);
  if not exists(select 1 from public.project_reviewed_briefs where project_id=p_project_id and document_id=p_document_id)
    then raise exception 'brief_already_designated' using errcode='PB001'; end if;
end $$;

-- Compare the complete snapshot: this includes hash/revision/path and extraction
-- readiness/hash. Lock the version as well as its parent against in-place saves.
create or replace function public.project_brief_check_source(p_project_id uuid,p_source jsonb)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from public.documents where id=(p_source->>'documentId')::uuid
    and project_id=p_project_id and archived_at is null for update;
  if not found then raise exception 'brief_stale' using errcode='PB001'; end if;
  perform 1 from public.document_versions where id=(p_source->>'versionId')::uuid for update;
  perform 1 from public.document_version_texts where version_id=(p_source->>'versionId')::uuid for share;
  if public.project_brief_source((p_source->>'documentId')::uuid) is distinct from p_source
    or (p_source->>'ready')::boolean is not true then
    raise exception 'brief_stale' using errcode='PB001'; end if;
end $$;

create or replace function public.project_brief_save_proposal(p_project_id uuid,p_actor_id uuid,p_actor_email text,p_proposal jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare b public.project_reviewed_briefs%rowtype; s jsonb;
begin
  perform public.project_brief_access(p_project_id,p_actor_id,p_actor_email,true);
  select * into b from public.project_reviewed_briefs where project_id=p_project_id for update;
  if b.document_id is distinct from (p_proposal->'base'->>'documentId')::uuid then
    raise exception 'brief_stale' using errcode='PB001'; end if;
  -- One deterministic lock order for all evidence and target documents.
  for s in select value from jsonb_array_elements((p_proposal->'sources') || jsonb_build_array(p_proposal->'base')) order by value->>'documentId' loop
    perform public.project_brief_check_source(p_project_id,s);
  end loop;
  insert into public.project_brief_proposals(id,project_id,actor_id,base,sources,content,before_text,gaps,staged_version)
  values((p_proposal->>'id')::uuid,p_project_id,p_actor_id,p_proposal->'base',p_proposal->'sources',
    p_proposal->'content',p_proposal->>'before',p_proposal->'gaps',p_proposal->'stagedVersion');
end $$;

-- Document-lifecycle owner: activation + checkpoint + proposal completion are
-- one transaction. No reviewed records can advance after a failed version save.
create or replace function public.project_brief_apply(p_project_id uuid,p_actor_id uuid,p_actor_email text,p_proposal_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare b public.project_reviewed_briefs%rowtype; q public.project_brief_proposals%rowtype; s jsonb; v jsonb;
begin
  perform public.project_brief_access(p_project_id,p_actor_id,p_actor_email,true);
  select * into b from public.project_reviewed_briefs where project_id=p_project_id for update;
  select * into q from public.project_brief_proposals where id=p_proposal_id and project_id=p_project_id and actor_id=p_actor_id for update;
  if not found then raise exception 'brief_not_found' using errcode='P0002'; end if;
  if q.applied_at is not null then return jsonb_build_object('versionId',q.applied_version_id,'replayed',true); end if;
  if q.expires_at<now() or b.document_id is distinct from (q.base->>'documentId')::uuid then
    raise exception 'brief_stale' using errcode='PB001'; end if;
  for s in select value from jsonb_array_elements(q.sources || jsonb_build_array(q.base)) order by value->>'documentId' loop
    perform public.project_brief_check_source(p_project_id,s);
  end loop;
  -- Reauthorize after acquiring locks, immediately before the write.
  perform public.project_brief_access(p_project_id,p_actor_id,p_actor_email,true);
  v:=public.create_document_version(b.document_id,q.staged_version,true);
  update public.project_reviewed_briefs set accepted_snapshot=public.project_brief_source(b.document_id),
    accepted_content=q.content,accepted_at=now(),accepted_by=p_actor_id where project_id=p_project_id;
  insert into public.project_brief_reviews(proposal_id,project_id,source)
    select q.id,p_project_id,value from jsonb_array_elements(q.sources);
  update public.project_brief_proposals set applied_version_id=(v->>'id')::uuid,applied_at=now() where id=q.id;
  return jsonb_build_object('versionId',v->>'id','replayed',false);
end $$;

-- These are internal service-role APIs, never direct browser RPCs.
revoke all on function public.project_brief_source(uuid),public.project_brief_access(uuid,uuid,text,boolean),
  public.project_brief_bundle(uuid,uuid,text,uuid[]),public.project_brief_designate(uuid,uuid,text,uuid),
  public.project_brief_check_source(uuid,jsonb),public.project_brief_save_proposal(uuid,uuid,text,jsonb),
  public.project_brief_apply(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.project_brief_source(uuid),public.project_brief_access(uuid,uuid,text,boolean),
  public.project_brief_bundle(uuid,uuid,text,uuid[]),public.project_brief_designate(uuid,uuid,text,uuid),
  public.project_brief_check_source(uuid,jsonb),public.project_brief_save_proposal(uuid,uuid,text,jsonb),
  public.project_brief_apply(uuid,uuid,text,uuid) to service_role;
