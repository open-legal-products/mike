-- Migration date: 2026-11-02
-- Private previews and per-source import receipts; no mailbox cursor or watcher.
create table if not exists public.project_email_previews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  folder_id uuid, -- Retain the confirmed destination if deleted; import must fail, never fall back to root.
  grant_id uuid not null, account_id text not null, account_email text not null,
  query text not null, manifest jsonb not null,
  selected_ids jsonb, confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '1 hour'
);
create table if not exists public.project_email_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  account_id text not null, message_id text not null, part_key text not null,
  thread_id text not null, filename text not null,
  status text not null default 'pending' check (status in ('pending','processing','imported','excluded','failed')),
  document_id uuid, version_id uuid not null default gen_random_uuid(),
  -- IDs remain tombstones after document deletion. Never resurrect an import.
  reserved_document_id uuid not null default gen_random_uuid(),
  storage_path text, content_sha256 text, detail text,
  lease_id uuid, lease_until timestamptz,
  imported_at timestamptz, import_preview_id uuid,
  staged_paths text[] not null default '{}',
  constraint project_email_identity unique(user_id, project_id, account_id, message_id, part_key)
);
alter table public.project_email_previews enable row level security;
alter table public.project_email_items enable row level security;
revoke all on public.project_email_previews, public.project_email_items from public, anon, authenticated;
grant select, insert, update, delete on public.project_email_previews, public.project_email_items to service_role;

create or replace function public.create_project_email_preview(p_preview jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.project_email_previews(id,user_id,project_id,org_id,folder_id,grant_id,account_id,account_email,query,manifest,expires_at)
    values((p_preview->>'id')::uuid,(p_preview->>'user_id')::uuid,(p_preview->>'project_id')::uuid,(p_preview->>'org_id')::uuid,
      (p_preview->>'folder_id')::uuid,(p_preview->>'grant_id')::uuid,p_preview->>'account_id',p_preview->>'account_email',p_preview->>'query',p_preview->'manifest',(p_preview->>'expires_at')::timestamptz);
  insert into public.db_jobs(kind,payload,max_attempts,run_at)
    values('project-email.cleanup',jsonb_build_object('previewId',p_preview->>'id'),8,(p_preview->>'expires_at')::timestamptz);
end; $$;
revoke all on function public.create_project_email_preview(jsonb) from public,anon,authenticated;
grant execute on function public.create_project_email_preview(jsonb) to service_role;

create or replace function public.claim_project_email_item(p_item jsonb, p_lease uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.project_email_items%rowtype;
begin
  insert into public.project_email_items(user_id,project_id,account_id,message_id,part_key,thread_id,filename)
    values((p_item->>'user_id')::uuid,(p_item->>'project_id')::uuid,p_item->>'account_id',p_item->>'message_id',p_item->>'part_key',p_item->>'thread_id',p_item->>'filename')
    on conflict on constraint project_email_identity do nothing;
  select * into r from public.project_email_items
    where user_id=(p_item->>'user_id')::uuid and project_id=(p_item->>'project_id')::uuid
      and account_id=p_item->>'account_id' and message_id=p_item->>'message_id' and part_key=p_item->>'part_key'
    for update;
  if r.status in ('imported','excluded') or (r.status='processing' and r.lease_until>now()) then return to_jsonb(r); end if;
  update public.project_email_items set status='processing',lease_id=p_lease,lease_until=now()+interval '10 minutes',detail=null
    where id=r.id returning * into r;
  return to_jsonb(r);
end; $$;
revoke all on function public.claim_project_email_item(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.claim_project_email_item(jsonb,uuid) to service_role;

create or replace function public.stage_project_email_item(p_item_id uuid,p_lease uuid,p_path text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.project_email_items set storage_path=p_path,staged_paths=array_append(staged_paths,p_path)
    where id=p_item_id and status='processing' and lease_id=p_lease and lease_until>now();
  if not found then return false; end if;
  -- The existing document cleanup worker protects any live version's keys.
  -- Thus a crash before finalization leaves a durable, delayed cleanup job;
  -- a successful import makes the same job harmless. No host file paths.
  insert into public.db_jobs(kind,payload,max_attempts,run_at)
    values('document.cleanup',jsonb_build_object('keys',jsonb_build_array(p_path)),8,now()+interval '24 hours');
  return true;
end; $$;
revoke all on function public.stage_project_email_item(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.stage_project_email_item(uuid,uuid,text) to service_role;

-- Documents-owned finalization: lifecycle activation + provenance share the
-- same transaction. Only the holder of this item's live lease may finalize.
create or replace function public.commit_project_email_document(p_item_id uuid,p_lease uuid,p_preview_id uuid,p_version jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.project_email_items%rowtype; v public.project_email_previews%rowtype; p public.projects%rowtype; role text;
begin
  select * into i from public.project_email_items where id=p_item_id for update;
  if not found or i.status<>'processing' or i.lease_id<>p_lease or i.lease_until<=now() or i.storage_path is distinct from p_version->>'storage_path' then raise exception 'email_intake_lease_lost'; end if;
  select * into v from public.project_email_previews where id=p_preview_id and user_id=i.user_id and project_id=i.project_id and account_id=i.account_id;
  if not found or v.confirmed_at is null or not (v.selected_ids ? i.message_id) then raise exception 'email_intake_not_confirmed'; end if;
  select * into p from public.projects where id=i.project_id for share;
  if not found or p.org_id is distinct from v.org_id then raise exception 'email_intake_access_changed'; end if;
  select public.project_access_role(p.id,p.user_id,p.org_id,i.user_id::text,u.email) into role from auth.users u where u.id=i.user_id;
  if role is null or role not in ('owner','editor') then raise exception 'email_intake_access_changed'; end if;
  perform 1 from public.user_google_workspace_tokens g where g.user_id=i.user_id and g.org_id is not distinct from v.org_id
    and g.provider='gmail' and g.grant_id=v.grant_id and g.account_id=i.account_id and g.enabled
    and not ('gmail_read_message'=any(g.disabled_tools));
  if not found then raise exception 'email_intake_connection_changed'; end if;
  if v.folder_id is not null and not exists(select 1 from public.project_subfolders where id=v.folder_id and project_id=p.id) then raise exception 'email_intake_destination_changed'; end if;
  insert into public.documents(id,project_id,org_id,user_id,folder_id,status)
    values(i.reserved_document_id,p.id,p.org_id,i.user_id,v.folder_id,'ready');
  perform public.create_document_version(i.reserved_document_id,
    p_version || jsonb_build_object('id',i.version_id,'source','user_upload','version_number',1),true);
  update public.project_email_items set status='imported',document_id=reserved_document_id,
    storage_path=p_version->>'storage_path',content_sha256=p_version->>'content_sha256',imported_at=now(),import_preview_id=v.id,lease_id=null,lease_until=null
    where id=i.id returning * into i;
  return to_jsonb(i);
end; $$;
revoke all on function public.commit_project_email_document(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commit_project_email_document(uuid,uuid,uuid,jsonb) to service_role;
