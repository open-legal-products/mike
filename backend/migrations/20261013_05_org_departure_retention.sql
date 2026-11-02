-- Migration date: 2026-10-13
-- Shared work survives departures; unshared work is recoverable by org owners
-- for 30 days. All membership paths use the same transactional trigger.

alter table public.projects add column if not exists archived_at timestamptz;

alter table public.workflows add column if not exists archived_at timestamptz;

alter table public.chats add column if not exists archived_at timestamptz;

alter table public.tabular_reviews add column if not exists archived_at timestamptz;

alter table public.documents add column if not exists archived_at timestamptz;

alter table public.user_profiles add column if not exists account_deletion_requested_at timestamptz;

create table if not exists public.org_departure_archives (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('project','workflow','chat','tabular_review','document')),
  item_id uuid not null,
  former_user_id uuid references auth.users(id) on delete set null,
  title text not null,
  archived_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  unique(kind, item_id)
);
create index if not exists org_departure_archives_org on public.org_departure_archives(org_id, archived_at, id);
create index if not exists org_departure_archives_expiry on public.org_departure_archives(expires_at);
alter table public.org_departure_archives enable row level security;
revoke all on public.org_departure_archives from anon, authenticated;
grant all on public.org_departure_archives to service_role;

-- Unlike personal history, the organization's audit trail survives erasure
-- of the departing account. No email or private item title is copied here.
create table if not exists public.org_departure_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists org_departure_events_org on public.org_departure_events(org_id, created_at);
alter table public.org_departure_events enable row level security;
revoke all on public.org_departure_events from anon, authenticated;
grant all on public.org_departure_events to service_role;

create or replace function public.org_default_departure_successor(p_org_id uuid, p_departing uuid[])
returns uuid language sql stable set search_path = public as $$
  select m.user_id from public.org_members m join public.organizations o on o.id=m.org_id
  where m.org_id=p_org_id and m.role='owner' and not (m.user_id=any(p_departing))
  order by (m.user_id=o.created_by) desc, m.created_at, m.user_id limit 1;
$$;

-- Standalone library files referenced by retained conversations/reviews are
-- dependencies, even though their original upload had no project container.
create or replace function public.org_item_document_ids(p_kind text, p_item_id uuid)
returns table(document_id uuid) language sql stable set search_path = public as $$
  select distinct d.id from public.documents d where
    (p_kind='project' and (d.project_id=p_item_id
      or exists(select 1 from public.chats c join public.chat_messages m on m.chat_id=c.id
        where c.project_id=p_item_id and m.files @> jsonb_build_array(jsonb_build_object('document_id',d.id::text)))
      or exists(select 1 from public.tabular_reviews r where r.project_id=p_item_id and (
        r.document_ids ? d.id::text
        or exists(select 1 from public.tabular_review_rows row where row.review_id=r.id and row.document_id=d.id)
        or exists(select 1 from public.tabular_review_rows row join public.tabular_review_row_sources source on source.row_id=row.id
          where row.review_id=r.id and source.document_id=d.id)))))
    or (p_kind='workflow' and d.workflow_id=p_item_id)
    or (p_kind='chat' and exists (
      select 1 from public.chat_messages m where m.chat_id=p_item_id
        and m.files @> jsonb_build_array(jsonb_build_object('document_id',d.id::text))))
    or (p_kind='tabular_review' and (
      exists (select 1 from public.tabular_reviews r where r.id=p_item_id and r.document_ids ? d.id::text)
      or exists (select 1 from public.tabular_review_rows r where r.review_id=p_item_id and r.document_id=d.id)
      or exists (select 1 from public.tabular_review_row_sources s join public.tabular_review_rows r on r.id=s.row_id
        where r.review_id=p_item_id and s.document_id=d.id)));
$$;

create or replace function public.org_members_departure_items(p_org_id uuid,p_user_ids uuid[])
returns table(kind text,item_id uuid,title text,disposition text)
language sql stable set search_path = public as $$
  with roots as (
select 'project'::text kind,item.id item_id,
    case when item.visibility='organization' then item.name else null::text end title,
    case when (item.visibility='organization' or exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.projects item where item.org_id=p_org_id and item.archived_at is null

    and (item.user_id=any(p_user_ids) or exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.project_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.project_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
 union all
select 'workflow'::text kind,item.id item_id,
    case when item.visibility='organization' then item.title else null::text end title,
    case when (item.visibility='organization' or exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.workflows item where item.org_id=p_org_id and item.archived_at is null

    and (item.user_id=any(p_user_ids) or exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.workflow_org_access_overrides g join public.org_members holder on holder.user_id=g.user_id and holder.org_id=p_org_id where g.workflow_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
 union all
select 'chat'::text kind,item.id item_id,
    null::text title,
    case when (exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.chats item where item.org_id=p_org_id and item.archived_at is null
    and item.project_id is null
    and (item.user_id=any(p_user_ids) or exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.chat_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.chat_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
 union all
select 'tabular_review'::text kind,item.id item_id,
    null::text title,
    case when (exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role in ('owner','editor','viewer') and not (holder.user_id = any(p_user_ids)))) then 'transfer' else 'archive' end disposition
  from public.tabular_reviews item where item.org_id=p_org_id and item.archived_at is null
    and item.project_id is null
    and (item.user_id=any(p_user_ids) or exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role='owner' and holder.user_id = any(p_user_ids)))
    and not exists (select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=item.user_id and not(m.user_id=any(p_user_ids)))
    and not exists (select 1 from public.tabular_review_access_grants g join public.user_profiles profile on lower(profile.email)=g.email join public.org_members holder on holder.user_id=profile.user_id and holder.org_id=p_org_id where g.tabular_review_id=item.id and g.role='owner' and not (holder.user_id = any(p_user_ids)))
  ), documents as (
    select 'document'::text kind,d.id item_id,null::text title,
      case when exists (
        select 1 from public.chats c
        where c.org_id=p_org_id and c.archived_at is null
          and not exists(select 1 from public.projects p where p.id=c.project_id and p.archived_at is not null)
          and exists (select 1 from public.org_item_document_ids('chat',c.id) ref where ref.document_id=d.id)
          and not exists (select 1 from roots r where r.kind='chat' and r.item_id=c.id and r.disposition='archive')
          and (c.project_id is null or not exists (select 1 from roots r where r.kind='project' and r.item_id=c.project_id and r.disposition='archive'))
      ) or exists (
        select 1 from public.tabular_reviews tr
        where tr.org_id=p_org_id and tr.archived_at is null
          and not exists(select 1 from public.projects p where p.id=tr.project_id and p.archived_at is not null)
          and exists (select 1 from public.org_item_document_ids('tabular_review',tr.id) ref where ref.document_id=d.id)
          and not exists (select 1 from roots r where r.kind='tabular_review' and r.item_id=tr.id and r.disposition='archive')
          and (tr.project_id is null or not exists (select 1 from roots r where r.kind='project' and r.item_id=tr.project_id and r.disposition='archive'))
      ) then 'transfer' else 'archive' end disposition
    from public.documents d where d.org_id=p_org_id and d.user_id=any(p_user_ids)
      and d.project_id is null and d.workflow_id is null and d.archived_at is null
  ) select * from roots union all select * from documents;
$$;

create or replace function public.org_member_sole_owned_items(p_org_id uuid,p_user_id uuid)
returns table(kind text,item_id uuid,title text) language sql stable set search_path = public as $$
  select i.kind,i.item_id,i.title from public.org_members_departure_items(p_org_id,array[p_user_id]) i where disposition='transfer';
$$;
create or replace function public.org_member_private_standalone(p_org_id uuid,p_user_id uuid)
returns table(kind text,item_id uuid) language sql stable set search_path = public as $$
  select i.kind,i.item_id from public.org_members_departure_items(p_org_id,array[p_user_id]) i
  where disposition='archive' and kind in ('chat','tabular_review','document');
$$;

create or replace function public.assign_org_departure_item(p_org_id uuid,p_kind text,p_item_id uuid,p_to_user_id uuid,p_actor_id uuid)
returns void language plpgsql set search_path = public as $$
declare target_email text; target_role text; visibility text;
begin
  select m.role,p.email into target_role,target_email from public.org_members m
    join public.user_profiles p on p.user_id=m.user_id where m.org_id=p_org_id and m.user_id=p_to_user_id;
  if not found then raise exception 'Choose a current organization member' using errcode='23514'; end if;
  if p_kind='project' then
    select p.visibility into visibility from public.projects p where p.id=p_item_id and p.org_id=p_org_id;
    if target_role<>'owner' or visibility<>'organization' then
      insert into public.project_org_access_overrides(project_id,org_id,user_id,role,assigned_by)
      values(p_item_id,p_org_id,p_to_user_id,'owner',p_actor_id)
      on conflict(project_id,user_id) do update set role='owner',assigned_by=excluded.assigned_by,updated_at=now();
    end if;
  elsif p_kind='workflow' then
    select w.visibility into visibility from public.workflows w where w.id=p_item_id and w.org_id=p_org_id;
    if target_role<>'owner' or visibility<>'organization' then
      insert into public.workflow_org_access_overrides(workflow_id,org_id,user_id,role,assigned_by)
      values(p_item_id,p_org_id,p_to_user_id,'owner',p_actor_id)
      on conflict(workflow_id,user_id) do update set role='owner',assigned_by=excluded.assigned_by,updated_at=now();
    end if;
  elsif p_kind='chat' then
    insert into public.chat_access_grants(chat_id,email,role,created_by) values(p_item_id,lower(target_email),'owner',p_actor_id)
    on conflict(chat_id,email) do update set role='owner',updated_at=now();
  elsif p_kind='tabular_review' then
    insert into public.tabular_review_access_grants(tabular_review_id,email,role,created_by) values(p_item_id,lower(target_email),'owner',p_actor_id)
    on conflict(tabular_review_id,email) do update set role='owner',updated_at=now();
  elsif p_kind='document' then
    update public.documents set user_id=p_to_user_id,library_folder_id=null where id=p_item_id and org_id=p_org_id;
  else raise exception 'Unknown item kind' using errcode='23514'; end if;
end;
$$;

create or replace function public.assign_org_member_items(p_org_id uuid,p_from_user_id uuid,p_to_user_id uuid,p_assigned_by uuid)
returns integer language plpgsql set search_path = public as $$
declare item record; assigned integer:=0;
begin
  if p_to_user_id is null or p_to_user_id=p_from_user_id or not exists (
    select 1 from public.org_members where org_id=p_org_id and user_id=p_to_user_id
  ) then raise exception 'Choose another current organization member' using errcode='23514'; end if;
  for item in select * from public.org_member_sole_owned_items(p_org_id,p_from_user_id) loop
    perform public.assign_org_departure_item(p_org_id,item.kind,item.item_id,p_to_user_id,p_assigned_by);
    assigned:=assigned+1;
  end loop;
  return assigned;
end;
$$;

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger language plpgsql set search_path = public as $$
declare item record; successor uuid; actor uuid; item_table text; item_title text;
declare snapshot jsonb;
begin
  perform 1 from public.organizations where id=old.org_id for update;
  if not found then return old; end if;
  if public.org_is_team(old.org_id) then
    successor:=coalesce(nullif(current_setting('mike.departure_successor',true),'')::uuid,
      public.org_default_departure_successor(old.org_id,array[old.user_id]));
    actor:=coalesce(nullif(current_setting('mike.departure_actor',true),'')::uuid,successor);
    -- Sharing writes lock their parent. Lock roots before classifying them.
    perform id from public.projects where org_id=old.org_id order by id for update;
    perform id from public.workflows where org_id=old.org_id order by id for update;
    perform id from public.chats where org_id=old.org_id order by id for update;
    perform id from public.tabular_reviews where org_id=old.org_id order by id for update;
    perform id from public.documents where org_id=old.org_id order by id for update;
    select coalesce(jsonb_agg(to_jsonb(i)),'[]') into snapshot
      from public.org_members_departure_items(old.org_id,array[old.user_id]) i;
    for item in select * from jsonb_to_recordset(snapshot) as x(kind text,item_id uuid,title text,disposition text) loop
      if item.disposition='transfer' then
        if successor is null or successor=old.user_id then
          raise exception 'An organization must keep at least one owner' using errcode='23514';
        end if;
        perform public.assign_org_departure_item(old.org_id,item.kind,item.item_id,successor,actor);
      else
        item_table:=case item.kind when 'project' then 'projects' when 'workflow' then 'workflows'
          when 'chat' then 'chats' when 'tabular_review' then 'tabular_reviews' else 'documents' end;
        if item.kind='document' then
          select coalesce(v.filename,'Untitled document') into item_title from public.documents d
            left join public.document_versions v on v.id=d.current_version_id where d.id=item.item_id;
        else
          execute format('select coalesce(%I, ''Untitled'') from public.%I where id=$1',
            case when item.kind='project' then 'name' else 'title' end,item_table) into item_title using item.item_id;
        end if;
        insert into public.org_departure_archives(org_id,kind,item_id,former_user_id,title)
          values(old.org_id,item.kind,item.item_id,old.user_id,item_title) on conflict(kind,item_id) do nothing;
        -- Null creator prevents a re-invited member reclaiming archived work.
        execute format('update public.%I set archived_at=now(),user_id=null where id=$1',item_table) using item.item_id;
        if item.kind='chat' then delete from public.chat_access_grants where chat_id=item.item_id;
        elsif item.kind='tabular_review' then delete from public.tabular_review_access_grants where tabular_review_id=item.item_id;
        end if;
      end if;
      insert into public.org_departure_events(org_id,actor_id,action,detail) values(old.org_id,actor,
        case when item.disposition='transfer' then 'item.transferred' else 'item.archived' end,
        jsonb_build_object('kind',item.kind,'item_id',item.item_id,'assigned_to',case when item.disposition='transfer' then successor end));
    end loop;
    insert into public.org_departure_events(org_id,actor_id,action,detail)
      values(old.org_id,actor,'member.departed',jsonb_build_object('transferred',
        (select count(*) from jsonb_array_elements(snapshot) x where x->>'disposition'='transfer'),
        'archived',(select count(*) from jsonb_array_elements(snapshot) x where x->>'disposition'='archive')));
  end if;
  if public.org_is_team(old.org_id) then
    update public.projects set user_id=null where org_id=old.org_id and user_id=old.user_id;
    update public.workflows set user_id=null where org_id=old.org_id and user_id=old.user_id;
    update public.chats set user_id=null where org_id=old.org_id and user_id=old.user_id;
    update public.tabular_reviews set user_id=null where org_id=old.org_id and user_id=old.user_id;
    update public.documents set user_id=null where org_id=old.org_id and user_id=old.user_id;
  end if;
  delete from public.project_org_access_overrides where org_id=old.org_id and user_id=old.user_id;
  delete from public.workflow_org_access_overrides where org_id=old.org_id and user_id=old.user_id;
  delete from public.chat_access_grants g using public.chats c,public.user_profiles p
    where g.chat_id=c.id and c.org_id=old.org_id and p.user_id=old.user_id and g.email=lower(p.email);
  delete from public.tabular_review_access_grants g using public.tabular_reviews r,public.user_profiles p
    where g.tabular_review_id=r.id and r.org_id=old.org_id and p.user_id=old.user_id and g.email=lower(p.email);
  return old;
end;
$$;

-- Both API removal and account erasure call this. Recheck roles while holding
-- the same organization lock that serializes last-owner changes.
create or replace function public.remove_org_member(p_org_id uuid,p_user_id uuid,p_actor_id uuid,p_successor_id uuid default null)
returns void language plpgsql set search_path = public as $$
declare actor_role text; target_role text;
begin
  perform 1 from public.organizations where id=p_org_id and kind='team' for update;
  if not found then raise exception 'Organization not found' using errcode='P0002'; end if;
  select role into actor_role from public.org_members where org_id=p_org_id and user_id=p_actor_id;
  select role into target_role from public.org_members where org_id=p_org_id and user_id=p_user_id;
  if actor_role is null or target_role is null then raise exception 'Member not found' using errcode='P0002'; end if;
  if p_actor_id<>p_user_id and not (actor_role='owner' or (actor_role='admin' and target_role='member')) then
    raise exception 'Cannot remove this member' using errcode='42501'; end if;
  if target_role='owner' and not exists(select 1 from public.org_members where org_id=p_org_id and role='owner' and user_id<>p_user_id) then
    raise exception 'An organization must keep at least one owner' using errcode='23514'; end if;
  if p_successor_id is not null and (p_successor_id=p_user_id or not exists (
    select 1 from public.org_members where org_id=p_org_id and user_id=p_successor_id
  )) then raise exception 'Choose another current organization member' using errcode='23514'; end if;
  perform set_config('mike.departure_successor',coalesce(p_successor_id::text,''),true);
  perform set_config('mike.departure_actor',p_actor_id::text,true);
  delete from public.org_members where org_id=p_org_id and user_id=p_user_id;
  perform set_config('mike.departure_successor','',true);
  perform set_config('mike.departure_actor','',true);
end;
$$;

create or replace function public.prepare_account_org_departures(p_user_id uuid)
returns void language plpgsql set search_path = public as $$
declare membership record;
begin
  -- Lock all organizations in a fixed order before changing any of them.
  perform o.id from public.organizations o join public.org_members m on m.org_id=o.id
    where m.user_id=p_user_id and o.kind='team' order by o.id for update of o;
  for membership in select m.org_id from public.org_members m join public.organizations o on o.id=m.org_id
    where m.user_id=p_user_id and o.kind='team' order by m.org_id loop
    perform public.remove_org_member(membership.org_id,p_user_id,p_user_id,null);
  end loop;
end;
$$;

create or replace function public.request_account_deletion(p_user_id uuid,p_user_email text)
returns uuid language plpgsql set search_path = public as $$
declare job_id uuid;
begin
  perform 1 from public.user_profiles where user_id=p_user_id for update;
  perform public.prepare_account_org_departures(p_user_id);
  insert into public.db_jobs(kind,payload,dedupe_key,max_attempts)
    values('account.delete',jsonb_build_object('userId',p_user_id,'userEmail',p_user_email),'account.delete:'||p_user_id,20)
    on conflict(dedupe_key) where dedupe_key is not null and status in ('pending','running') do update set dedupe_key=excluded.dedupe_key
    returning id into job_id;
  update public.user_profiles set account_deletion_requested_at=coalesce(account_deletion_requested_at,now()) where user_id=p_user_id;
  return job_id;
end;
$$;

create or replace function public.project_access_role(
  p_project_id uuid,
  p_project_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when exists(select 1 from public.projects where id=p_project_id and archived_at is not null) then null
    when p_org_id is not null then (
      select case
        when p_project_user_id::text = p_user_id then 'owner'
        -- An organization owner owns what is public, and what has no Owner
        -- left. A private item with an Owner is not theirs unless shared.
        when m.role = 'owner' and (
          (
            select project.visibility from public.projects project
            where project.id = p_project_id
          ) = 'organization'
          or public.project_is_ownerless(
            p_project_id, p_project_user_id, p_org_id
          )
        ) then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        when (
          select project.visibility from public.projects project
          where project.id = p_project_id
        ) = 'organization' then 'editor'
        else null
      end
      from public.org_members m
      left join public.project_org_access_overrides o
        on o.project_id = p_project_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_project_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.project_access_grants g
      where g.project_id = p_project_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.workflow_access_role(
  p_workflow_id uuid,
  p_workflow_user_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when exists(select 1 from public.workflows where id=p_workflow_id and archived_at is not null) then null
    when p_org_id is not null then (
      select case
        when p_workflow_user_id::text = p_user_id then 'owner'
        -- As for projects: public, or left without an Owner.
        when m.role = 'owner' and (
          (
            select workflow.visibility from public.workflows workflow
            where workflow.id = p_workflow_id
          ) = 'organization'
          or public.workflow_is_ownerless(
            p_workflow_id, p_workflow_user_id, p_org_id
          )
        ) then 'owner'
        when o.role = 'deny' then null
        when o.role in ('owner', 'editor', 'viewer') then o.role
        when (
          select workflow.visibility from public.workflows workflow
          where workflow.id = p_workflow_id
        ) = 'organization' then 'editor'
        else null
      end
      from public.org_members m
      left join public.workflow_org_access_overrides o
        on o.workflow_id = p_workflow_id
       and o.org_id = p_org_id
       and o.user_id = m.user_id
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    )
    when p_workflow_user_id::text = p_user_id then 'owner'
    else (
      -- BOTH sides lowered. get_workflows_overview lists a share with
      -- lower() on both, so a legacy mixed-case row listed for its recipient
      -- and then 404'd the moment they opened it (and re-sharing produced a
      -- second row rather than updating the first). The 02 migration
      -- normalizes the stored values and adds a lowercase CHECK; this stays
      -- symmetrical with the overview regardless.
      select s.role from public.workflow_shares s
      where s.workflow_id = p_workflow_id
        and coalesce(p_user_email, '') <> ''
        and lower(s.shared_with_email) = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.chat_access_role(
  p_chat_id uuid,
  p_chat_user_id uuid,
  p_project_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when exists(select 1 from public.chats where id=p_chat_id and archived_at is not null) then null
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when public.org_is_team(p_org_id) then public.standalone_org_access_role(
      p_org_id,
      p_chat_user_id,
      p_user_id,
      (
        select g.role from public.chat_access_grants g
        where g.chat_id = p_chat_id
          and coalesce(p_user_email, '') <> ''
          and g.email = lower(p_user_email)
        limit 1
      )
    )
    when p_chat_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.chat_access_grants g
      where g.chat_id = p_chat_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.review_access_role(
  p_review_id uuid,
  p_review_user_id uuid,
  p_project_id uuid,
  p_org_id uuid,
  p_user_id text,
  p_user_email text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when exists(select 1 from public.tabular_reviews where id=p_review_id and archived_at is not null) then null
    when p_project_id is not null then (
      select public.project_access_role(
        p.id, p.user_id, p.org_id, p_user_id, p_user_email
      ) from public.projects p where p.id = p_project_id
    )
    when public.org_is_team(p_org_id) then public.standalone_org_access_role(
      p_org_id,
      p_review_user_id,
      p_user_id,
      (
        select g.role from public.tabular_review_access_grants g
        where g.tabular_review_id = p_review_id
          and coalesce(p_user_email, '') <> ''
          and g.email = lower(p_user_email)
        limit 1
      )
    )
    when p_review_user_id::text = p_user_id then 'owner'
    else (
      select g.role from public.tabular_review_access_grants g
      where g.tabular_review_id = p_review_id
        and coalesce(p_user_email, '') <> ''
        and g.email = lower(p_user_email)
      limit 1
    )
  end;
$$;

create or replace function public.validate_direct_access_scope()
returns trigger
language plpgsql
set search_path = public
as $$
declare invalid_scope boolean;
begin
  case tg_table_name
    when 'project_access_grants' then
      select (p.org_id is not null or p.archived_at is not null) into invalid_scope
      from public.projects p where p.id = new.project_id for update;
    when 'chat_access_grants' then
      select (c.project_id is not null or c.archived_at is not null) into invalid_scope
      from public.chats c where c.id = new.chat_id for update;
    when 'tabular_review_access_grants' then
      select (tr.project_id is not null or tr.archived_at is not null) into invalid_scope
      from public.tabular_reviews tr where tr.id = new.tabular_review_id for update;
    when 'workflow_shares' then
      select (w.org_id is not null or w.archived_at is not null) into invalid_scope
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported direct access table';
  end case;
  if coalesce(invalid_scope, true) then
    raise exception 'Direct grants are not allowed for organization or inherited content'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_org_access_override()
returns trigger
language plpgsql
set search_path = public
as $$
declare resource_org_id uuid;
declare resource_creator_id uuid;
declare resource_visibility text;
declare member_role text;
declare archived timestamptz;
begin
  case tg_table_name
    when 'project_org_access_overrides' then
      select p.org_id, p.user_id, p.visibility, p.archived_at
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.projects p where p.id = new.project_id for update;
    when 'workflow_org_access_overrides' then
      select w.org_id, w.user_id, w.visibility, w.archived_at
        into resource_org_id, resource_creator_id, resource_visibility, archived
      from public.workflows w where w.id = new.workflow_id for update;
    else
      raise exception 'Unsupported organization override table';
  end case;

  if archived is not null then
    raise exception 'Archived work must be restored by an organization owner' using errcode='23514';
  end if;
  if resource_org_id is null or resource_org_id is distinct from new.org_id then
    raise exception 'Organization override does not match the resource organization'
      using errcode = '23514';
  end if;
  if resource_creator_id = new.user_id then
    raise exception 'The creator is always an owner'
      using errcode = '23514';
  end if;
  select m.role into member_role
  from public.org_members m
  where m.org_id = new.org_id and m.user_id = new.user_id
  for key share;
  if not found then
    raise exception 'Organization access overrides require active membership'
      using errcode = '23514';
  end if;
  -- An organization owner owns every public item, so there is nothing to
  -- give or deny them there. A private item is not theirs unless shared, so
  -- there they are given a role like any other member.
  if member_role = 'owner' and resource_visibility = 'organization' then
    raise exception 'Organization owners always own a public item'
      using errcode = '23514';
  end if;
  return new;
end;
$$;


create or replace function public.org_archive_deleted_item()
returns trigger language plpgsql set search_path = public as $$
begin
  delete from public.org_departure_archives where kind=TG_ARGV[0] and item_id=old.id;
  return old;
end;
$$;

drop trigger if exists org_archive_cleanup on public.projects;
create trigger org_archive_cleanup after delete on public.projects for each row execute function public.org_archive_deleted_item('project');

drop trigger if exists org_archive_cleanup on public.workflows;
create trigger org_archive_cleanup after delete on public.workflows for each row execute function public.org_archive_deleted_item('workflow');

drop trigger if exists org_archive_cleanup on public.chats;
create trigger org_archive_cleanup after delete on public.chats for each row execute function public.org_archive_deleted_item('chat');

drop trigger if exists org_archive_cleanup on public.tabular_reviews;
create trigger org_archive_cleanup after delete on public.tabular_reviews for each row execute function public.org_archive_deleted_item('tabular_review');

drop trigger if exists org_archive_cleanup on public.documents;
create trigger org_archive_cleanup after delete on public.documents for each row execute function public.org_archive_deleted_item('document');


create or replace function public.resolve_org_departure_archive(p_org_id uuid,p_archive_id uuid,p_actor_id uuid,p_successor_id uuid default null,p_delete boolean default false)
returns void language plpgsql set search_path = public as $$
declare archived public.org_departure_archives; item_table text; dependent record;
begin
  perform 1 from public.organizations where id=p_org_id for update;
  if not exists(select 1 from public.org_members where org_id=p_org_id and user_id=p_actor_id and role='owner') then
    raise exception 'Only organization owners can manage archived work' using errcode='42501'; end if;
  select * into archived from public.org_departure_archives where id=p_archive_id and org_id=p_org_id for update;
  if not found then raise exception 'Archived item not found' using errcode='P0002'; end if;
  if not p_delete and archived.expires_at<=now() then raise exception 'The recovery period has ended' using errcode='23514'; end if;
  item_table:=case archived.kind when 'project' then 'projects' when 'workflow' then 'workflows' when 'chat' then 'chats'
    when 'tabular_review' then 'tabular_reviews' else 'documents' end;
  if p_delete then
    execute format('delete from public.%I where id=$1 and org_id=$2',item_table) using archived.item_id,p_org_id;
  else
    if p_successor_id is null or not exists(select 1 from public.org_members where org_id=p_org_id and user_id=p_successor_id) then
      raise exception 'Choose a current organization member' using errcode='23514'; end if;
    -- Restore library dependencies alongside their conversation/review.
    for dependent in select a.id from public.org_departure_archives a
      join public.org_item_document_ids(archived.kind,archived.item_id) d on d.document_id=a.item_id
      where a.org_id=p_org_id and a.kind='document' and a.expires_at>now() loop
      perform public.resolve_org_departure_archive(p_org_id,dependent.id,p_actor_id,p_successor_id,false);
    end loop;
    execute format('update public.%I set archived_at=null where id=$1 and org_id=$2',item_table) using archived.item_id,p_org_id;
    perform public.assign_org_departure_item(p_org_id,archived.kind,archived.item_id,p_successor_id,p_actor_id);
  end if;
  delete from public.org_departure_archives where id=archived.id;
  insert into public.org_departure_events(org_id,actor_id,action,detail) values(p_org_id,p_actor_id,
    case when p_delete then 'item.deleted' else 'item.recovered' end,
    jsonb_build_object('kind',archived.kind,'item_id',archived.item_id,'assigned_to',p_successor_id));
end;
$$;

create or replace function public.expire_org_departure_archives(p_limit integer default 100)
returns integer language plpgsql set search_path = public as $$
declare archived record; item_table text; deleted integer:=0;
begin
  for archived in select * from public.org_departure_archives where expires_at<=now()
    order by expires_at,id limit greatest(1,least(p_limit,1000)) for update skip locked loop
    item_table:=case archived.kind when 'project' then 'projects' when 'workflow' then 'workflows' when 'chat' then 'chats'
      when 'tabular_review' then 'tabular_reviews' else 'documents' end;
    execute format('delete from public.%I where id=$1 and org_id=$2 and archived_at is not null',item_table) using archived.item_id,archived.org_id;
    delete from public.org_departure_archives where id=archived.id;
    insert into public.org_departure_events(org_id,action,detail) values(archived.org_id,'item.expired',
      jsonb_build_object('kind',archived.kind,'item_id',archived.item_id));
    deleted:=deleted+1;
  end loop;
  return deleted;
end;
$$;

revoke all on function public.org_default_departure_successor(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.org_default_departure_successor(uuid,uuid[]) to service_role;

revoke all on function public.org_item_document_ids(text,uuid) from public,anon,authenticated;
grant execute on function public.org_item_document_ids(text,uuid) to service_role;

revoke all on function public.org_members_departure_items(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.org_members_departure_items(uuid,uuid[]) to service_role;

revoke all on function public.org_member_sole_owned_items(uuid,uuid) from public,anon,authenticated;
grant execute on function public.org_member_sole_owned_items(uuid,uuid) to service_role;

revoke all on function public.org_member_private_standalone(uuid,uuid) from public,anon,authenticated;
grant execute on function public.org_member_private_standalone(uuid,uuid) to service_role;

revoke all on function public.assign_org_departure_item(uuid,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assign_org_departure_item(uuid,text,uuid,uuid,uuid) to service_role;

revoke all on function public.assign_org_member_items(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.assign_org_member_items(uuid,uuid,uuid,uuid) to service_role;

revoke all on function public.cleanup_removed_org_member_overrides() from public,anon,authenticated;
grant execute on function public.cleanup_removed_org_member_overrides() to service_role;

revoke all on function public.remove_org_member(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.remove_org_member(uuid,uuid,uuid,uuid) to service_role;

revoke all on function public.prepare_account_org_departures(uuid) from public,anon,authenticated;
grant execute on function public.prepare_account_org_departures(uuid) to service_role;

revoke all on function public.request_account_deletion(uuid,text) from public,anon,authenticated;
grant execute on function public.request_account_deletion(uuid,text) to service_role;

revoke all on function public.project_access_role(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.project_access_role(uuid,uuid,uuid,text,text) to service_role;

revoke all on function public.workflow_access_role(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.workflow_access_role(uuid,uuid,uuid,text,text) to service_role;

revoke all on function public.chat_access_role(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.chat_access_role(uuid,uuid,uuid,uuid,text,text) to service_role;

revoke all on function public.review_access_role(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.review_access_role(uuid,uuid,uuid,uuid,text,text) to service_role;

revoke all on function public.validate_direct_access_scope() from public,anon,authenticated;
grant execute on function public.validate_direct_access_scope() to service_role;

revoke all on function public.validate_org_access_override() from public,anon,authenticated;
grant execute on function public.validate_org_access_override() to service_role;

revoke all on function public.org_archive_deleted_item() from public,anon,authenticated;
grant execute on function public.org_archive_deleted_item() to service_role;

revoke all on function public.resolve_org_departure_archive(uuid,uuid,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.resolve_org_departure_archive(uuid,uuid,uuid,uuid,boolean) to service_role;

revoke all on function public.expire_org_departure_archives(integer) from public,anon,authenticated;
grant execute on function public.expire_org_departure_archives(integer) to service_role;

create or replace function public.project_is_ownerless(
  p_project_id uuid,
  p_project_user_id uuid,
  p_org_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_org_id is not null
    and not exists(select 1 from public.projects where id=p_project_id and archived_at is not null)
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = p_project_user_id
    )
    and not exists (
      select 1 from public.project_org_access_overrides o
      where o.project_id = p_project_id and o.role = 'owner'
    );
$$;

create or replace function public.workflow_is_ownerless(
  p_workflow_id uuid,
  p_workflow_user_id uuid,
  p_org_id uuid
)
returns boolean
language sql
stable
set search_path = public
as $$
  select p_org_id is not null
    and not exists(select 1 from public.workflows where id=p_workflow_id and archived_at is not null)
    and not exists (
      select 1 from public.org_members creator
      where creator.org_id = p_org_id and creator.user_id = p_workflow_user_id
    )
    and not exists (
      select 1 from public.workflow_org_access_overrides o
      where o.workflow_id = p_workflow_id and o.role = 'owner'
    );
$$;

create or replace function public.list_org_departure_archives(p_org_id uuid,p_actor_id uuid,p_limit integer default 51,p_offset integer default 0)
returns setof public.org_departure_archives language sql stable set search_path = public as $$
  select a.* from public.org_departure_archives a
  where a.org_id=p_org_id and a.expires_at>now()
    and exists(select 1 from public.org_members m where m.org_id=p_org_id and m.user_id=p_actor_id and m.role='owner')
  order by a.archived_at,a.id limit greatest(1,least(p_limit,101)) offset greatest(0,p_offset);
$$;
revoke all on function public.list_org_departure_archives(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.list_org_departure_archives(uuid,uuid,integer,integer) to service_role;
