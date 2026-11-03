-- Migration date: 2026-11-02
-- Project brief state is identity-bound, never inferred from a filename.
create table if not exists public.project_reviewed_briefs (
  project_id uuid primary key references public.projects(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  designation_id uuid not null default gen_random_uuid(),
  accepted_snapshot jsonb,
  accepted_content jsonb,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null
);
-- Brief metadata belongs to the project, even after normal document deletion.
-- Upgrade the earlier prototype's cascading/non-null document binding in place.
alter table public.project_reviewed_briefs alter column document_id drop not null;
do $$ begin
  if not exists(select 1 from pg_constraint
    where conrelid='public.project_reviewed_briefs'::regclass
      and conname='project_reviewed_briefs_document_id_fkey'
      and contype='f' and confrelid='public.documents'::regclass and confdeltype='n') then
    alter table public.project_reviewed_briefs drop constraint if exists project_reviewed_briefs_document_id_fkey;
    alter table public.project_reviewed_briefs add constraint project_reviewed_briefs_document_id_fkey
      foreign key(document_id) references public.documents(id) on delete set null;
  end if;
end $$;
-- A moved document can be designated in its new project while the old
-- project retains its historical binding. Current project membership, not global
-- document uniqueness, determines the active designation.
alter table public.project_reviewed_briefs drop constraint if exists project_reviewed_briefs_document_id_key;
create index if not exists project_reviewed_briefs_document_idx on public.project_reviewed_briefs(document_id);
create table if not exists public.project_brief_proposals (
  id uuid primary key,
  project_id uuid not null references public.project_reviewed_briefs(project_id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  designation_id uuid not null,
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
-- Upgrade earlier unmerged prototype databases without deleting history.
-- Only the currently accepted legacy proposal proves its designation. Other
-- legacy proposals retain independent generations and must be regenerated;
-- matching document IDs alone cannot reconstruct a past leave/rebind cycle.
alter table public.project_reviewed_briefs add column if not exists designation_id uuid;
update public.project_reviewed_briefs set designation_id=gen_random_uuid() where designation_id is null;
alter table public.project_reviewed_briefs alter column designation_id set default gen_random_uuid();
alter table public.project_reviewed_briefs alter column designation_id set not null;
alter table public.project_brief_proposals add column if not exists designation_id uuid;
update public.project_brief_proposals q set designation_id=case
  when q.applied_at is not null and q.applied_version_id=(b.accepted_snapshot->>'versionId')::uuid
    then b.designation_id else gen_random_uuid() end
from public.project_reviewed_briefs b where q.project_id=b.project_id and q.designation_id is null;
alter table public.project_brief_proposals alter column designation_id set not null;
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

-- FK SET NULL detaches a deleted document atomically. Retain historical rows,
-- but never leave their accepted position or reviewed stamps active.
create or replace function public.project_brief_detach_deleted_document()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if old.document_id is not null and new.document_id is null then
    new.designation_id:=gen_random_uuid();
    new.accepted_snapshot:=null;
    new.accepted_content:=null;
    new.accepted_at:=null;
    new.accepted_by:=null;
  end if;
  return new;
end $$;
drop trigger if exists project_brief_detach_deleted_document on public.project_reviewed_briefs;
create trigger project_brief_detach_deleted_document before update of document_id on public.project_reviewed_briefs
  for each row execute function public.project_brief_detach_deleted_document();

-- Keep identity/fingerprint audit rows without retaining copied text from a
-- physically deleted base brief, including a former designation in any project.
create index if not exists project_brief_proposals_base_document_idx
  on public.project_brief_proposals((base->>'documentId'));
create or replace function public.project_brief_scrub_deleted_base()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  -- Version cascade rows may already be gone while their FK SET NULL event
  -- is still queued. Match that final FK state before updating copied text.
  update public.project_brief_proposals q set before_text='',
    content='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb,
    gaps='[]'::jsonb,
    applied_version_id=case when exists(select 1 from public.document_versions v
      where v.id=q.applied_version_id) then q.applied_version_id else null end
  where q.base->>'documentId'=old.id::text
    -- Project cascade may have removed this parent while its proposal cascade
    -- is still queued. Those rows will disappear; do not update dying children.
    and exists(select 1 from public.project_reviewed_briefs binding where binding.project_id=q.project_id);
  return old;
end $$;
drop trigger if exists project_brief_scrub_deleted_base on public.documents;
create trigger project_brief_scrub_deleted_base after delete on public.documents
  for each row execute function public.project_brief_scrub_deleted_base();
-- Also repair retained rows whose base was deleted before this revision.
update public.project_brief_proposals q set before_text='',
  content='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb,
  gaps='[]'::jsonb
where not exists(select 1 from public.documents d where d.id=(q.base->>'documentId')::uuid);

-- Version deletion follows the same copied-text policy, including the normal
-- soft-delete lifecycle. Missing staged versions are expected for pending work.
create index if not exists project_brief_proposals_base_version_idx
  on public.project_brief_proposals((base->>'versionId'));
create index if not exists project_brief_proposals_staged_version_idx
  on public.project_brief_proposals((staged_version->>'id'));
create or replace function public.project_brief_scrub_deleted_version()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  update public.project_brief_proposals q set before_text='',
    content='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb,
    gaps='[]'::jsonb,
    applied_version_id=case when exists(select 1 from public.document_versions v
      where v.id=q.applied_version_id) then q.applied_version_id else null end
  where (q.base->>'versionId'=old.id::text or q.staged_version->>'id'=old.id::text)
    and exists(select 1 from public.project_reviewed_briefs binding where binding.project_id=q.project_id);
  update public.project_reviewed_briefs binding set accepted_content=null
  where binding.accepted_snapshot->>'versionId'=old.id::text
    and exists(select 1 from public.projects project where project.id=binding.project_id)
    -- A missing document is awaiting FK detach, which clears acceptance itself.
    and (binding.document_id is null or exists(select 1 from public.documents document where document.id=binding.document_id));
  return old;
end $$;
drop trigger if exists project_brief_scrub_deleted_version on public.document_versions;
create trigger project_brief_scrub_deleted_version after delete on public.document_versions
  for each row execute function public.project_brief_scrub_deleted_version();
drop trigger if exists project_brief_scrub_tombstoned_version on public.document_versions;
create trigger project_brief_scrub_tombstoned_version after update of deleted_at on public.document_versions
  for each row when(old.deleted_at is null and new.deleted_at is not null)
  execute function public.project_brief_scrub_deleted_version();
update public.project_brief_proposals q set before_text='',
  content='{"position":[],"awaiting":[],"uncertainties":[],"nextAction":[]}'::jsonb,
  gaps='[]'::jsonb
where not exists(select 1 from public.document_versions v
    where v.id=(q.base->>'versionId')::uuid and v.deleted_at is null)
  or (q.applied_at is not null and not exists(select 1 from public.document_versions v
    where v.id=(q.staged_version->>'id')::uuid and v.deleted_at is null));

update public.project_reviewed_briefs binding set accepted_content=null
where binding.accepted_content is not null and binding.accepted_snapshot is not null
  and not exists(select 1 from public.document_versions v
    where v.id=(binding.accepted_snapshot->>'versionId')::uuid and v.deleted_at is null);

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
      when v.storage_path is null then 'Stored file unavailable'
      when t.source_revision is distinct from v.text_revision or t.source_sha256 is distinct from v.content_sha256 then 'Extraction is stale or pending'
      when t.extractor_version is distinct from 1 then 'Extraction must be refreshed'
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
declare b public.project_reviewed_briefs%rowtype; s jsonb; snapshots jsonb; role text; accepted_live boolean; pending_proposal_id uuid;
begin
  role:=public.project_brief_access(p_project_id,p_actor_id,p_actor_email,false);
  if cardinality(p_selected)>0 and (select count(*) from public.documents where project_id=p_project_id and archived_at is null)>500 then
    raise exception 'brief_project_limit' using errcode='22023'; end if;
  if exists(select 1 from unnest(p_selected) selected(document_id) where not exists(
    select 1 from public.documents d where d.id=selected.document_id and d.project_id=p_project_id and d.archived_at is null)) then
    raise exception 'brief_not_found' using errcode='P0002'; end if;
  select * into b from public.project_reviewed_briefs where project_id=p_project_id;
  -- The materialization fence prevents repeated full-text hashing in the
  -- review predicate and reuses the same snapshot for the designated brief.
  with source_snapshots as materialized (
    select d.id document_id,d.current_version_id,public.project_brief_source(d.id) source
    from public.documents d where d.project_id=p_project_id and d.archived_at is null
  ), pending_proposal as (
    select q.id from public.project_brief_proposals q
    where q.project_id=p_project_id and q.actor_id=p_actor_id and q.designation_id=b.designation_id
      and q.applied_at is null and q.expires_at>now()
      and q.base=(select source from source_snapshots where document_id=b.document_id)
      -- This inventory contains only active documents in the requested project.
      -- Compare plain identities before adding presentation text/reviewed fields.
      and not exists(select 1 from jsonb_array_elements(q.sources) source_row(value)
        where not exists(select 1 from source_snapshots current_source
          where current_source.document_id=(source_row.value->>'documentId')::uuid
            and current_source.source=source_row.value))
    order by q.created_at desc limit 1
  )
  select coalesce(jsonb_agg(x.snapshot order by x.document_id),'[]'),
    (select source from source_snapshots where document_id=b.document_id),
    (select id from pending_proposal)
    into snapshots,s,pending_proposal_id from (
    select d.document_id, coalesce(d.source,jsonb_build_object('documentId',d.document_id,'versionId','','revision','','hash','','textHash','','filename','Document awaiting version','ready',false,'reason','No active readable version')) || jsonb_build_object(
      'reviewed',exists(select 1 from source_snapshots live_brief where live_brief.document_id=b.document_id and live_brief.source is not null)
        and exists(select 1 from public.project_brief_reviews r where r.project_id=p_project_id
        and r.source=d.source and exists(select 1 from public.project_brief_proposals reviewed_proposal where reviewed_proposal.id=r.proposal_id and reviewed_proposal.designation_id=b.designation_id)),
      'text',case when d.document_id=b.document_id or d.document_id=any(p_selected) then
        (select t.text_content from public.document_version_texts t where t.version_id=d.current_version_id) end
    ) snapshot from source_snapshots d
  ) x where x.snapshot is not null;
  accepted_live:=s is not null and exists(select 1 from public.document_versions accepted_version
    where accepted_version.id=(b.accepted_snapshot->>'versionId')::uuid
      and accepted_version.document_id=b.document_id and accepted_version.deleted_at is null);
  return jsonb_build_object('designationId',b.designation_id,'brief',s,'accepted',case when accepted_live then b.accepted_snapshot end,'acceptedContent',case when accepted_live then b.accepted_content end,
    'pendingProposalId',pending_proposal_id,
    'acceptedEvidence',case when not accepted_live then '[]'::jsonb else coalesce((select jsonb_build_array(q.base)||q.sources from public.project_brief_proposals q where q.project_id=p_project_id and q.applied_version_id=(b.accepted_snapshot->>'versionId')::uuid order by q.applied_at desc limit 1),'[]'::jsonb) end,
    'acceptedAt',case when accepted_live then b.accepted_at end,'canEdit',role in ('owner','editor'),'sources',snapshots);
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
      designation_id=excluded.designation_id,accepted_snapshot=null,accepted_content=null,accepted_at=null,accepted_by=null
    where not exists(select 1 from public.documents old_brief where old_brief.id=project_reviewed_briefs.document_id and old_brief.project_id=p_project_id and old_brief.archived_at is null);
  if not exists(select 1 from public.project_reviewed_briefs where project_id=p_project_id and document_id=p_document_id)
    then raise exception 'brief_already_designated' using errcode='PB002'; end if;
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
  if (select count(*) from public.documents where project_id=p_project_id and archived_at is null)>500 then
    raise exception 'brief_project_limit' using errcode='22023'; end if;
  select * into b from public.project_reviewed_briefs where project_id=p_project_id for update;
  if b.designation_id is null or b.designation_id is distinct from (p_proposal->>'designationId')::uuid
    or b.document_id is distinct from (p_proposal->'base'->>'documentId')::uuid then
    raise exception 'brief_stale' using errcode='PB001'; end if;
  -- One deterministic lock order for all evidence and target documents.
  for s in select value from jsonb_array_elements((p_proposal->'sources') || jsonb_build_array(p_proposal->'base')) order by value->>'documentId' loop
    perform public.project_brief_check_source(p_project_id,s);
  end loop;
  insert into public.project_brief_proposals(id,project_id,actor_id,designation_id,base,sources,content,before_text,gaps,staged_version)
  values((p_proposal->>'id')::uuid,p_project_id,p_actor_id,b.designation_id,p_proposal->'base',p_proposal->'sources',
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
  if q.applied_at is not null then
    if q.applied_version_id is null or not exists(select 1 from public.document_versions
      where id=q.applied_version_id and deleted_at is null) then
      raise exception 'brief_version_not_found' using errcode='P0002'; end if;
    return jsonb_build_object('versionId',q.applied_version_id,'replayed',true);
  end if;
  if q.expires_at<now() or q.designation_id is distinct from b.designation_id
    or b.document_id is distinct from (q.base->>'documentId')::uuid then
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
revoke all on function public.project_brief_detach_deleted_document(),public.project_brief_scrub_deleted_base(),public.project_brief_scrub_deleted_version(),public.project_brief_source(uuid),public.project_brief_access(uuid,uuid,text,boolean),
  public.project_brief_bundle(uuid,uuid,text,uuid[]),public.project_brief_designate(uuid,uuid,text,uuid),
  public.project_brief_check_source(uuid,jsonb),public.project_brief_save_proposal(uuid,uuid,text,jsonb),
  public.project_brief_apply(uuid,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.project_brief_detach_deleted_document(),public.project_brief_scrub_deleted_base(),public.project_brief_scrub_deleted_version(),public.project_brief_source(uuid),public.project_brief_access(uuid,uuid,text,boolean),
  public.project_brief_bundle(uuid,uuid,text,uuid[]),public.project_brief_designate(uuid,uuid,text,uuid),
  public.project_brief_check_source(uuid,jsonb),public.project_brief_save_proposal(uuid,uuid,text,jsonb),
  public.project_brief_apply(uuid,uuid,text,uuid) to service_role;
