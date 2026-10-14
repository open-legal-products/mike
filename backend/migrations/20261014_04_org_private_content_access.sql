-- Migration date: 2026-10-14
-- Administrative standing is separate from ordinary content sharing.
alter table public.org_members add column if not exists can_access_private_content boolean not null default false;
alter table public.org_members drop constraint if exists org_members_private_content_admin;
alter table public.org_members add constraint org_members_private_content_admin
  check (not can_access_private_content or role='admin');

create table if not exists public.org_private_content_access (
  org_id uuid not null,
  user_id uuid not null,
  kind text not null check(kind in ('project','workflow','chat','tabular_review','document')),
  item_id uuid not null,
  opened_at timestamptz not null default now(),
  primary key(org_id,user_id,kind,item_id),
  foreign key(org_id,user_id) references public.org_members(org_id,user_id) on delete cascade
);
alter table public.org_private_content_access enable row level security;
revoke all on public.org_private_content_access from public,anon,authenticated;
grant select,insert,update,delete on public.org_private_content_access to service_role;

create or replace function public.can_access_org_private_content(p_org_id uuid,p_user_id uuid)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.org_members m join public.organizations o on o.id=m.org_id
    where m.org_id=p_org_id and m.user_id=p_user_id and o.kind='team' and o.deleted_at is null
      and (m.role='owner' or (m.role='admin' and m.can_access_private_content)));
$$;

-- Only active, current organization items can be accessed. No personal rows,
-- archived rows, or cross-organization references enter this catalog.
create or replace function public.org_private_content_items(p_org_id uuid)
returns table(kind text,item_id uuid,title text,user_id uuid) language sql stable set search_path=public,pg_temp as $$
  select 'project',id,name,user_id from public.projects
    where org_id=p_org_id and archived_at is null and visibility='private'
  union all select 'workflow',id,title,user_id from public.workflows
    where org_id=p_org_id and archived_at is null and visibility='private'
  union all select 'chat',id,title,user_id from public.chats
    where org_id=p_org_id and archived_at is null and project_id is null
  union all select 'tabular_review',id,title,user_id from public.tabular_reviews
    where org_id=p_org_id and archived_at is null and project_id is null
  union all select 'document',d.id,coalesce(v.filename,'Untitled document'),d.user_id
    from public.documents d left join public.document_versions v on v.id=d.current_version_id and v.deleted_at is null
    where d.org_id=p_org_id and d.archived_at is null and d.project_id is null and d.workflow_id is null;
$$;

create or replace function public.org_private_access_role(p_org_id uuid,p_kind text,p_item_id uuid,p_user_id text)
returns text language sql stable set search_path=public,pg_temp as $$
  select 'viewer'::text where exists (
    select 1 from public.org_private_content_access a
    join public.org_private_content_items(p_org_id) item on item.kind=a.kind and item.item_id=a.item_id
    where a.org_id=p_org_id and a.user_id::text=p_user_id and a.kind=p_kind and a.item_id=p_item_id
      and public.can_access_org_private_content(p_org_id,a.user_id)
  );
$$;

-- Reading a private chat/review includes its referenced files, but only files
-- still in this organization. It does not grant access to a personal upload.
create or replace function public.org_private_document_access(p_org_id uuid,p_document_id uuid,p_user_id text)
returns boolean language sql stable set search_path=public,pg_temp as $$
  select exists(select 1 from public.documents d where d.id=p_document_id and d.org_id=p_org_id
    and d.archived_at is null and (
      public.org_private_access_role(p_org_id,'document',d.id,p_user_id) is not null
      or exists(select 1 from public.org_private_content_access a
        join public.org_private_content_items(p_org_id) item on item.kind=a.kind and item.item_id=a.item_id
        join public.org_item_document_ids(a.kind,a.item_id) attached on attached.document_id=d.id
        where a.org_id=p_org_id and a.user_id::text=p_user_id
          and public.can_access_org_private_content(p_org_id,a.user_id))
    ));
$$;

create or replace function public.set_org_private_content_permission(p_org_id uuid,p_actor_id uuid,p_target_id uuid,p_enabled boolean)
returns void language plpgsql set search_path=public,pg_temp as $$
declare target_email text;
begin
  perform 1 from public.organizations where id=p_org_id and kind='team' and deleted_at is null for update;
  if not found then raise exception 'Organization not found' using errcode='P0002'; end if;
  perform 1 from public.org_members where org_id=p_org_id and user_id=p_actor_id and role='owner' for update;
  if not found then raise exception 'Owner required' using errcode='42501'; end if;
  perform 1 from public.org_members where org_id=p_org_id and user_id=p_target_id and role='admin' for update;
  if not found then raise exception 'Choose an organization admin' using errcode='23514'; end if;
  if p_enabled is null then raise exception 'Choose a permission' using errcode='23514'; end if;
  update public.org_members set can_access_private_content=p_enabled,updated_at=now()
    where org_id=p_org_id and user_id=p_target_id;
  select email into target_email from public.user_profiles where user_id=p_target_id;
  insert into public.audit_events(org_id,user_id,action,title,surface,detail)
    values(p_org_id,p_actor_id,'org.private_content.permission_changed',target_email,'organization',
      jsonb_build_object('target_user_id',p_target_id,'enabled',p_enabled));
end;
$$;

create or replace function public.open_org_private_content(p_org_id uuid,p_actor_id uuid,p_kind text,p_item_id uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
declare item_title text;
begin
  perform 1 from public.organizations where id=p_org_id and kind='team' and deleted_at is null for update;
  if not found then raise exception 'Organization not found' using errcode='P0002'; end if;
  perform 1 from public.org_members where org_id=p_org_id and user_id=p_actor_id for update;
  if not public.can_access_org_private_content(p_org_id,p_actor_id) then
    raise exception 'Private content permission required' using errcode='42501';
  end if;
  select title into item_title from public.org_private_content_items(p_org_id) where kind=p_kind and item_id=p_item_id;
  if not found then raise exception 'Item not found' using errcode='P0002'; end if;
  insert into public.org_private_content_access(org_id,user_id,kind,item_id) values(p_org_id,p_actor_id,p_kind,p_item_id)
    on conflict(org_id,user_id,kind,item_id) do update set opened_at=now();
  -- Grant and audit entry commit together. An audit failure denies access.
  insert into public.audit_events(org_id,user_id,action,title,surface,detail)
    values(p_org_id,p_actor_id,'org.private_content.opened',left(item_title,300),'organization',
      jsonb_build_object('kind',p_kind,'item_id',p_item_id,'access','viewer'));
end;
$$;

create or replace function public.close_org_private_content(p_org_id uuid,p_actor_id uuid,p_kind text,p_item_id uuid)
returns void language plpgsql set search_path=public,pg_temp as $$
begin
  delete from public.org_private_content_access where org_id=p_org_id and user_id=p_actor_id and kind=p_kind and item_id=p_item_id;
  if found then
    insert into public.audit_events(org_id,user_id,action,surface,detail)
      values(p_org_id,p_actor_id,'org.private_content.closed','organization',jsonb_build_object('kind',p_kind,'item_id',p_item_id));
  end if;
end;
$$;

create or replace function public.list_org_private_content(p_org_id uuid,p_actor_id uuid,p_limit integer default 50,p_offset integer default 0,p_search text default '')
returns table(kind text,item_id uuid,title text,user_id uuid,display_name text,email text,has_access boolean)
language plpgsql stable set search_path=public,pg_temp as $$
begin
  if not public.can_access_org_private_content(p_org_id,p_actor_id) then
    raise exception 'Private content permission required' using errcode='42501';
  end if;
  return query select item.kind,item.item_id,item.title,item.user_id,profile.display_name,profile.email,
    exists(select 1 from public.org_private_content_access a where a.org_id=p_org_id and a.user_id=p_actor_id and a.kind=item.kind and a.item_id=item.item_id)
    from public.org_private_content_items(p_org_id) item left join public.user_profiles profile on profile.user_id=item.user_id
    where item.user_id is distinct from p_actor_id and (p_search='' or position(lower(p_search) in lower(coalesce(item.title,'')))>0)
    order by lower(item.title) nulls last,item.kind,item.item_id
    limit greatest(1,least(p_limit,101)) offset greatest(0,p_offset);
end;
$$;

-- Removal, demotion and revocation erase explicit access rather than letting
-- old grants reappear when a member is promoted or re-enabled later.
create or replace function public.revoke_org_private_content_on_membership_change()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.role is distinct from old.role or (old.can_access_private_content and not new.can_access_private_content) then
    delete from public.org_private_content_access where org_id=old.org_id and user_id=old.user_id;
  end if;
  if new.role<>'admin' or new.role is distinct from old.role then new.can_access_private_content:=false; end if;
  return new;
end;
$$;
drop trigger if exists revoke_org_private_content_on_membership_change on public.org_members;
create trigger revoke_org_private_content_on_membership_change before update on public.org_members
  for each row execute function public.revoke_org_private_content_on_membership_change();

create or replace function public.clear_org_private_item_access()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if tg_op='DELETE' or new.org_id is distinct from old.org_id or new.user_id is distinct from old.user_id or new.archived_at is distinct from old.archived_at then
    delete from public.org_private_content_access where kind=tg_argv[0] and item_id=old.id;
  end if;
  return coalesce(new,old);
end;
$$;
do $$ declare item record; begin
  for item in select * from (values('projects','project'),('workflows','workflow'),('chats','chat'),('tabular_reviews','tabular_review'),('documents','document')) as items(table_name,kind) loop
    execute format('drop trigger if exists clear_org_private_item_access on public.%I',item.table_name);
    execute format('create trigger clear_org_private_item_access after update or delete on public.%I for each row execute function public.clear_org_private_item_access(%L)',item.table_name,item.kind);
  end loop;
end; $$;

-- These actor-parameterized functions are server-only, like the ordinary
-- access-role functions. Browser JWTs never get an impersonation primitive.
revoke all on function public.can_access_org_private_content(uuid,uuid),public.org_private_content_items(uuid),public.org_private_access_role(uuid,text,uuid,text),public.org_private_document_access(uuid,uuid,text),public.set_org_private_content_permission(uuid,uuid,uuid,boolean),public.open_org_private_content(uuid,uuid,text,uuid),public.close_org_private_content(uuid,uuid,text,uuid),public.list_org_private_content(uuid,uuid,integer,integer,text) from public,anon,authenticated;
grant execute on function public.can_access_org_private_content(uuid,uuid),public.org_private_content_items(uuid),public.org_private_access_role(uuid,text,uuid,text),public.org_private_document_access(uuid,uuid,text),public.set_org_private_content_permission(uuid,uuid,uuid,boolean),public.open_org_private_content(uuid,uuid,text,uuid),public.close_org_private_content(uuid,uuid,text,uuid),public.list_org_private_content(uuid,uuid,integer,integer,text) to service_role;

-- Batched equivalents for directory and export authorization; page past the
-- REST row limit without losing grants. Each read rechecks current permission.
create or replace function public.list_org_private_content_access(p_org_ids uuid[],p_user_id text,p_offset integer default 0)
returns table(kind text,item_id uuid) language sql stable set search_path=public,pg_temp as $$
  select a.kind,a.item_id from public.org_private_content_access a
    join lateral public.org_private_content_items(a.org_id) item on item.kind=a.kind and item.item_id=a.item_id
    where a.org_id=any(p_org_ids) and a.user_id::text=p_user_id
      and public.can_access_org_private_content(a.org_id,a.user_id)
    order by a.org_id,a.kind,a.item_id limit 500 offset greatest(0,p_offset);
$$;
revoke all on function public.list_org_private_content_access(uuid[],text,integer) from public,anon,authenticated;
grant execute on function public.list_org_private_content_access(uuid[],text,integer) to service_role;

create or replace function public.clear_org_private_access_on_deletion()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if new.deleted_at is distinct from old.deleted_at then
    delete from public.org_private_content_access where org_id=old.id;
  end if;
  return new;
end;
$$;
drop trigger if exists clear_org_private_access_on_deletion on public.organizations;
create trigger clear_org_private_access_on_deletion after update of deleted_at on public.organizations
  for each row execute function public.clear_org_private_access_on_deletion();

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
  select coalesce((case
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
  end), public.org_private_access_role(p_org_id,'project',p_project_id,p_user_id));
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
  select coalesce((case
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
  end), public.org_private_access_role(p_org_id,'workflow',p_workflow_id,p_user_id));
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
  select coalesce((case
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
  end), public.org_private_access_role(p_org_id,'chat',p_chat_id,p_user_id));
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
  select coalesce((case
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
  end), public.org_private_access_role(p_org_id,'tabular_review',p_review_id,p_user_id));
$$;

create or replace function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text)
returns setof public.audit_events language sql stable set search_path = public, pg_temp as $$
  with scoped as (
    select a.*, (
      (a.action like 'org.%' and (a.action not in ('org.private_content.opened','org.private_content.closed') or public.can_access_org_private_content(p_org_id,p_actor_id))) or a.user_id=p_actor_id
      or public.project_access_role(p.id,p.user_id,p.org_id,p_actor_id::text,p_actor_email) is not null
      or public.chat_access_role(c.id,c.user_id,c.project_id,c.org_id,p_actor_id::text,p_actor_email) is not null
      or public.review_access_role(v.id,v.user_id,v.project_id,v.org_id,p_actor_id::text,p_actor_email) is not null
      or (d.id is not null and (
        public.project_access_role(dp.id,dp.user_id,dp.org_id,p_actor_id::text,p_actor_email) is not null
        or public.workflow_access_role(w.id,w.user_id,w.org_id,p_actor_id::text,p_actor_email) is not null
        or (d.project_id is null and d.workflow_id is null and d.user_id=p_actor_id and d.archived_at is null)
        or public.org_private_document_access(d.org_id,d.id,p_actor_id::text)
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
