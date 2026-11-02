-- Migration date: 2026-10-14
-- Organization audit attribution and a recoverable, owner-controlled lifecycle.
alter table public.organizations add column if not exists deleted_at timestamptz;
alter table public.organizations add column if not exists purge_after timestamptz;
alter table public.organizations drop constraint if exists organizations_deletion_window;
alter table public.organizations add constraint organizations_deletion_window check (
  (deleted_at is null and purge_after is null) or
  (kind = 'team' and deleted_at is not null and purge_after is not null and purge_after > deleted_at)
);
create index if not exists organizations_purge_due on public.organizations(purge_after) where deleted_at is not null;

-- Attribution survives content and organization deletion. It is deliberately
-- not a foreign key: audit records describe historical resources too.
alter table public.audit_events add column if not exists org_id uuid;
create index if not exists audit_events_org_created on public.audit_events(org_id, created_at desc, id);
alter table public.audit_events alter column user_id drop not null;
alter table public.audit_events drop constraint if exists audit_events_user_id_fkey;
alter table public.audit_events add constraint audit_events_user_id_fkey foreign key(user_id) references auth.users(id) on delete set null;

create or replace function public.audit_event_org()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.action like 'org.%' and new.surface is null then new.surface := 'organization'; end if;
  if new.org_id is not null then return new; end if;
  if new.detail->>'org_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    new.org_id := (new.detail->>'org_id')::uuid;
  end if;
  if new.org_id is null and new.project_id is not null then
    select org_id into new.org_id from public.projects where id=new.project_id;
  end if;
  if new.org_id is null and new.chat_id is not null then
    select coalesce(c.org_id,p.org_id) into new.org_id from public.chats c
      left join public.projects p on p.id=c.project_id where c.id=new.chat_id;
  end if;
  if new.org_id is null and new.review_id is not null then
    select coalesce(v.org_id,p.org_id) into new.org_id from public.tabular_reviews v
      left join public.projects p on p.id=v.project_id where v.id=new.review_id;
  end if;
  if new.org_id is null and new.document_id is not null then
    select coalesce(d.org_id,p.org_id,w.org_id) into new.org_id from public.documents d
      left join public.projects p on p.id=d.project_id
      left join public.workflows w on w.id=d.workflow_id where d.id=new.document_id;
  end if;
  return new;
end;
$$;
drop trigger if exists audit_event_org on public.audit_events;
create trigger audit_event_org before insert or update of org_id on public.audit_events
  for each row execute function public.audit_event_org();
-- Only backfill provable associations. Never infer from a user's current org.
update public.audit_events set org_id=org_id where org_id is null;

create or replace function public.org_is_active(p_org_id uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select p_org_id is null or exists(select 1 from public.organizations where id=p_org_id and deleted_at is null);
$$;

-- Serialize lifecycle actions and new organization-owned writes. This also
-- closes invitation acceptance and content creation races with deletion.
create or replace function public.require_active_organization()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op='UPDATE' and old.org_id is not null then
    perform 1 from public.organizations where id=old.org_id and deleted_at is null for share;
    if not found then raise exception 'Organization is unavailable' using errcode='23514'; end if;
  end if;
  if new.org_id is not null then
    perform 1 from public.organizations where id=new.org_id and deleted_at is null for share;
    if not found then raise exception 'Organization is unavailable' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;
do $$ declare t text; begin
  foreach t in array array['org_members','org_invitations','projects','workflows','documents','chats','tabular_reviews','memory_files'] loop
    execute format('drop trigger if exists require_active_organization on public.%I',t);
    execute format('create trigger require_active_organization before insert or update of org_id on public.%I for each row execute function public.require_active_organization()',t);
  end loop;
end $$;

create or replace function public.soft_delete_organization(p_org_id uuid,p_actor_id uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
declare org public.organizations; actor_role text;
begin
  select * into org from public.organizations where id=p_org_id and kind='team' for update;
  if not found then raise exception 'Organization not found' using errcode='P0002'; end if;
  select role into actor_role from public.org_members where org_id=p_org_id and user_id=p_actor_id;
  if actor_role is null then raise exception 'Organization not found' using errcode='P0002'; end if;
  if actor_role <> 'owner' then raise exception 'Only owners can delete organizations' using errcode='42501'; end if;
  if org.deleted_at is not null then return; end if;
  update public.organizations set deleted_at=now(),purge_after=now()+interval '30 days',updated_at=now() where id=p_org_id;
  insert into public.audit_events(user_id,user_email,org_id,action,title,surface,detail)
    values(p_actor_id,(select email from public.user_profiles where user_id=p_actor_id),p_org_id,'org.deleted',org.name,'organization',jsonb_build_object('purge_after',now()+interval '30 days'));
end;
$$;

create or replace function public.restore_organization(p_org_id uuid,p_actor_id uuid)
returns void language plpgsql set search_path = public, pg_temp as $$
declare org public.organizations; actor_role text;
begin
  select * into org from public.organizations where id=p_org_id and kind='team' for update;
  if not found then raise exception 'Organization not found' using errcode='P0002'; end if;
  select role into actor_role from public.org_members where org_id=p_org_id and user_id=p_actor_id;
  if actor_role is null then raise exception 'Organization not found' using errcode='P0002'; end if;
  if actor_role <> 'owner' then raise exception 'Only owners can restore organizations' using errcode='42501'; end if;
  if org.deleted_at is null then return; end if;
  if org.purge_after <= now() then raise exception 'Recovery period has ended' using errcode='23514'; end if;
  update public.organizations set deleted_at=null,purge_after=null,updated_at=now() where id=p_org_id;
  insert into public.audit_events(user_id,user_email,org_id,action,title,surface)
    values(p_actor_id,(select email from public.user_profiles where user_id=p_actor_id),p_org_id,'org.restored',org.name,'organization');
end;
$$;

-- One transaction per bounded sweep, with the same lock as restore. Document
-- version deletion triggers enqueue durable storage cleanup in this transaction.
create or replace function public.purge_expired_organizations(p_limit integer default 10)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare org record; purged integer := 0;
begin
  for org in select id,name from public.organizations where purge_after<=now()
    order by purge_after,id limit greatest(1,least(p_limit,100)) for update skip locked loop
    delete from public.projects where org_id=org.id;
    delete from public.workflows where org_id=org.id;
    delete from public.documents where org_id=org.id;
    delete from public.tabular_reviews where org_id=org.id;
    delete from public.chats where org_id=org.id;
    delete from public.memory_files where org_id=org.id;
    insert into public.audit_events(org_id,action,title,surface) values(org.id,'org.purged',org.name,'organization');
    delete from public.organizations where id=org.id;
    purged := purged+1;
  end loop;
  return purged;
end;
$$;

-- The ordinary membership API hides deleted organizations; recovery is the
-- sole exception and explicitly requires a retained owner membership.
create or replace view public.active_org_members with (security_invoker=true) as
  select m.* from public.org_members m join public.organizations o on o.id=m.org_id where o.deleted_at is null;
revoke all on public.active_org_members from public,anon,authenticated;
grant select on public.active_org_members to service_role;

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
    when not public.org_is_active(p_org_id) then null
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
    when not public.org_is_active(p_org_id) then null
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

create or replace function public.standalone_org_access_role(
  p_org_id uuid,
  p_creator_id uuid,
  p_user_id text,
  p_grant_role text
)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when not public.org_is_active(p_org_id) then null
    when not exists (
      select 1 from public.org_members m
      where m.org_id = p_org_id and m.user_id::text = p_user_id
    ) then null
    when p_creator_id::text = p_user_id then 'owner'
    else p_grant_role
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
    when not public.org_is_active(p_org_id) then null
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
    when not public.org_is_active(p_org_id) then null
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

create or replace function public.ensure_user_memory_file(
  p_user_id uuid,
  p_org_id uuid
)
returns setof public.memory_files
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_org_id is not null and not exists (
    select 1 from public.active_org_members member
    where member.org_id = p_org_id and member.user_id = p_user_id
  ) then
    return;
  end if;
  if not exists (
    select 1 from public.memory_files file
    where file.scope = 'user'
      and file.user_id = p_user_id
      and file.org_id is not distinct from p_org_id
  ) then
    insert into public.memory_files(scope, user_id, org_id, enabled)
    values (
      'user',
      p_user_id,
      p_org_id,
      coalesce((
        select personal.enabled from public.memory_files personal
        where personal.scope = 'user'
          and personal.user_id = p_user_id
          and personal.org_id is null
      ), true)
    )
    on conflict do nothing;
  end if;
  return query
    select file.* from public.memory_files file
    where file.scope = 'user'
      and file.user_id = p_user_id
      and file.org_id is not distinct from p_org_id;
end;
$$;

create or replace function public.memory_source_allows_app_memory(
  p_surface text,
  p_conversation_id uuid,
  p_actor_user_id uuid,
  p_project_id uuid
)
returns boolean
language sql
-- Re-read grants after the caller's project-row lock wait. A stable function
-- could retain the statement's older snapshot while a concurrent share wins.
volatile
security definer
set search_path = public, pg_temp
as $$
  -- App memory is private to one user, so it may only learn from a
  -- conversation nobody else can read. That is a property of the
  -- conversation itself (its owner, organization, and direct grants) and,
  -- when it lives in a project, of the project too. The read path in the
  -- routes applies the same three tests before showing app memory.
  --
  -- A chat started on its own in a team organization's workspace is private
  -- to its author too, and learns into that author's memory FOR THAT
  -- WORKSPACE (memory_source_org_id says which). A chat in an organization's
  -- project is the project's, and never learns into anybody's own memory.
  select case
    when p_surface = 'word' then p_project_id is null
    when p_surface = 'chat' then
      exists (
        select 1
        from public.chats chat
        where chat.id = p_conversation_id
          and chat.user_id = p_actor_user_id
          and (
            not public.org_is_team(chat.org_id)
            or (
              chat.project_id is null
              and exists (
                select 1 from public.active_org_members member
                where member.org_id = chat.org_id
                  and member.user_id = p_actor_user_id
              )
            )
          )
          and not exists (
            select 1
            from public.chat_access_grants grant_row
            where grant_row.chat_id = chat.id
          )
      )
      and (
        p_project_id is null
        or public.memory_project_is_private(p_project_id)
      )
    when p_surface = 'tabular' then
      p_project_id is not null
      and exists (
        select 1
        from public.tabular_review_chats chat
        join public.tabular_reviews review on review.id = chat.review_id
        where chat.id = p_conversation_id
          and review.user_id = p_actor_user_id
          and review.org_id is null
          and not exists (
            select 1
            from public.tabular_review_access_grants grant_row
            where grant_row.tabular_review_id = review.id
          )
      )
      and public.memory_project_is_private(p_project_id)
    else false
  end;
$$;

create or replace function public.prepare_account_org_departures(p_user_id uuid)
returns void language plpgsql set search_path = public as $$
declare membership record;
begin
  -- Lock all organizations in a fixed order before changing any of them.
  perform o.id from public.organizations o join public.org_members m on m.org_id=o.id
    where m.user_id=p_user_id and o.kind='team' and o.deleted_at is null order by o.id for update of o;
  for membership in select m.org_id from public.org_members m join public.organizations o on o.id=m.org_id
    where m.user_id=p_user_id and o.kind='team' and o.deleted_at is null order by m.org_id loop
    perform public.remove_org_member(membership.org_id,p_user_id,p_user_id,null);
  end loop;
end;
$$;

create or replace function public.audit_org_departure()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  insert into public.audit_events(org_id,user_id,action,surface,detail)
    values(new.org_id,new.actor_id,'org.departure.'||new.action,'organization',new.detail);
  return new;
end;
$$;
drop trigger if exists audit_org_departure on public.org_departure_events;
create trigger audit_org_departure after insert on public.org_departure_events for each row execute function public.audit_org_departure();
revoke all on function public.audit_event_org(),public.org_is_active(uuid),public.require_active_organization(),
 public.soft_delete_organization(uuid,uuid),public.restore_organization(uuid,uuid),public.purge_expired_organizations(integer),public.audit_org_departure()
 from public,anon,authenticated;
grant execute on function public.audit_event_org(),public.org_is_active(uuid),public.require_active_organization(),
 public.soft_delete_organization(uuid,uuid),public.restore_organization(uuid,uuid),public.purge_expired_organizations(integer),public.audit_org_departure()
 to service_role;

create or replace function public.cleanup_removed_org_member_overrides()
returns trigger language plpgsql set search_path = public as $$
declare item record; successor uuid; actor uuid; item_table text; item_title text;
declare snapshot jsonb;
begin
  perform 1 from public.organizations where id=old.org_id for update;
  if not found or not public.org_is_active(old.org_id) then return old; end if;
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

-- Administration can inspect activity without acquiring access to private
-- content. Redact inaccessible titles/details/links BEFORE search/sort/export,
-- so filters cannot be used to guess a colleague's private prompt or title.
create or replace function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text)
returns setof public.audit_events language sql stable set search_path = public, pg_temp as $$
  with scoped as (
    select a.*, (
      a.action like 'org.%' or a.user_id=p_actor_id
      or public.project_access_role(p.id,p.user_id,p.org_id,p_actor_id::text,p_actor_email) is not null
      or public.chat_access_role(c.id,c.user_id,c.project_id,c.org_id,p_actor_id::text,p_actor_email) is not null
      or public.review_access_role(v.id,v.user_id,v.project_id,v.org_id,p_actor_id::text,p_actor_email) is not null
      or (d.id is not null and (
        public.project_access_role(dp.id,dp.user_id,dp.org_id,p_actor_id::text,p_actor_email) is not null
        or public.workflow_access_role(w.id,w.user_id,w.org_id,p_actor_id::text,p_actor_email) is not null
        or (d.project_id is null and d.workflow_id is null and d.user_id=p_actor_id and d.archived_at is null)
      ))
    ) as can_view
    from public.audit_events a
    left join public.projects p on p.id=a.project_id
    left join public.chats c on c.id=a.chat_id
    left join public.tabular_reviews v on v.id=a.review_id
    left join public.documents d on d.id=a.document_id
    left join public.projects dp on dp.id=d.project_id
    left join public.workflows w on w.id=d.workflow_id
    where a.org_id=p_org_id and exists(
      select 1 from public.active_org_members m where m.org_id=p_org_id and m.user_id=p_actor_id and m.role in ('owner','admin')
    )
  )
  select (jsonb_populate_record(null::public.audit_events, (to_jsonb(s)-'can_view') ||
    case when s.can_view then '{}'::jsonb else jsonb_build_object(
      'title',null,'detail',null,'project_id',null,'chat_id',null,'review_id',null,'document_id',null
    ) end)).* from scoped s;
$$;
revoke all on function public.organization_audit_events(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.organization_audit_events(uuid,uuid,text) to service_role;
