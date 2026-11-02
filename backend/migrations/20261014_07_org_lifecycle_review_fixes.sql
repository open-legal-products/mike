-- Migration date: 2026-10-14
-- Preserve lifecycle serialization without blocking ordinary organization updates.
create or replace function public.require_active_organization()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op='UPDATE' and old.org_id is not null then
    perform 1 from public.organizations where id=old.org_id and deleted_at is null for key share;
    if not found then raise exception 'Organization is unavailable' using errcode='23514'; end if;
  end if;
  if new.org_id is not null then
    perform 1 from public.organizations where id=new.org_id and deleted_at is null for key share;
    if not found then raise exception 'Organization is unavailable' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;

-- Account deletion may cascade memberships while an organization is deleted.
create or replace function public.cleanup_removed_org_member_overrides()
returns trigger language plpgsql set search_path = public as $$
declare item record; successor uuid; actor uuid; item_table text; item_title text;
declare snapshot jsonb; active boolean; former_user uuid;
begin
  select deleted_at is null into active from public.organizations where id=old.org_id for update;
  if not found then return old; end if;
  if public.org_is_team(old.org_id) then
    -- The auth row is already gone during an account-deletion cascade.
    select id into former_user from auth.users where id=old.user_id;
    if active then
      successor:=coalesce(nullif(current_setting('mike.departure_successor',true),'')::uuid,
      public.org_default_departure_successor(old.org_id,array[old.user_id]));
      actor:=coalesce(nullif(current_setting('mike.departure_actor',true),'')::uuid,successor);
    end if;
    -- Sharing writes lock their parent. Lock roots before classifying them.
    perform id from public.projects where org_id=old.org_id order by id for update;
    perform id from public.workflows where org_id=old.org_id order by id for update;
    perform id from public.chats where org_id=old.org_id order by id for update;
    perform id from public.tabular_reviews where org_id=old.org_id order by id for update;
    perform id from public.documents where org_id=old.org_id order by id for update;
    -- Deleted organizations cannot transfer work. Archive every departure
    -- item so restoring the organization never exposes ownerless private work.
    select coalesce(jsonb_agg(to_jsonb(i) ||
      case when active then '{}'::jsonb else '{"disposition":"archive"}'::jsonb end),'[]') into snapshot
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
          values(old.org_id,item.kind,item.item_id,former_user,item_title) on conflict(kind,item_id) do nothing;
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
