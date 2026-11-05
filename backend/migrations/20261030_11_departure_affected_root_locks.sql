-- Migration date: 2026-10-30
create or replace function public.cleanup_removed_org_member_overrides()
returns trigger language plpgsql set search_path = public as $$
declare item record; successor uuid; actor uuid; item_table text; item_title text;
declare snapshot jsonb; active boolean; former_user uuid; needs_reference_fence boolean;
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
    -- Keep the organization serialization fence (also used by membership
    -- and account deletion). Projects/workflows need only affected-root locks.
    -- Grant mutations lock their parent, and grants to the departing member
    -- also lock that membership. Keep the original table/id lock order.
    -- JSON document references do not acquire a document FK lock. A retained
    -- chat/review can therefore hold an uncommitted reference to departing
    -- documents. Keep their historical broad fence whenever this actor has
    -- owned documents; checking only currently active/standalone documents
    -- would miss an in-flight restore or move. New document inserts
    -- acquire the organization fence, so cannot appear behind this check.
    select exists(select 1 from public.documents
      where org_id=old.org_id and user_id=old.user_id)
      into needs_reference_fence;
    perform root.id from public.projects root join (
      select id from public.projects where org_id=old.org_id and user_id=old.user_id
      union select project_id from public.project_org_access_overrides where org_id=old.org_id and user_id=old.user_id and role='owner'
    ) affected on affected.id=root.id
    where root.org_id=old.org_id order by root.id for update of root;
    perform root.id from public.workflows root join (
      select id from public.workflows where org_id=old.org_id and user_id=old.user_id
      union select workflow_id from public.workflow_org_access_overrides where org_id=old.org_id and user_id=old.user_id and role='owner'
    ) affected on affected.id=root.id
    where root.org_id=old.org_id order by root.id for update of root;
    if needs_reference_fence then
      perform id from public.chats where org_id=old.org_id order by id for update;
      perform id from public.tabular_reviews where org_id=old.org_id order by id for update;
    else
      perform root.id from public.chats root join (
        select id from public.chats where org_id=old.org_id and user_id=old.user_id
        union select g.chat_id from public.chat_access_grants g join public.user_profiles p on lower(p.email)=g.email
          where p.user_id=old.user_id and g.role='owner'
      ) affected on affected.id=root.id
      where root.org_id=old.org_id order by root.id for update of root;
      perform root.id from public.tabular_reviews root join (
        select id from public.tabular_reviews where org_id=old.org_id and user_id=old.user_id
        union select g.tabular_review_id from public.tabular_review_access_grants g join public.user_profiles p on lower(p.email)=g.email
          where p.user_id=old.user_id and g.role='owner'
      ) affected on affected.id=root.id
      where root.org_id=old.org_id order by root.id for update of root;
    end if;
    perform id from public.documents where org_id=old.org_id and user_id=old.user_id order by id for update;
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
