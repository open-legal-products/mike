-- Run with psql -v ON_ERROR_STOP=1 against a migrated LOCAL test database
-- (CI runs it on the fresh install in .github/workflows/schema-drift.yml).
-- Transactional fixtures only; everything rolls back.
--
-- get_chats_overview evaluates the chat access ladder with set-based joins
-- instead of calling chat_access_role() per row (MIKE-BACKEND-F). This file is
-- the contract between the two: for every branch of the ladder and every
-- actor, the list returns exactly the rows the per-row verdict grants, with
-- the same role, provenance, order and pages, and it never calls that verdict.
begin;
create function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception '%', message; end if;
end;
$$;

create temporary table chat_cases (id uuid primary key, label text not null);
-- uid is what the API passes (res.locals.userId); it is a uuid for every
-- Supabase account, but the ladder only compares it as text.
create temporary table actors (label text primary key, uid text, id uuid, email text);
create temporary table workspaces (label text primary key, workspace text);
-- What the caller must see, by case label; absent labels must stay hidden.
create temporary table expected_visible (label text primary key, role text not null);
create temporary sequence role_calls minvalue 0 start 0;

do $$
declare
  caller uuid := gen_random_uuid();
  colleague uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  auditor uuid := gen_random_uuid();   -- team admin allowed to open private content
  clerk uuid := gen_random_uuid();     -- team admin without that permission
  team uuid := gen_random_uuid();      -- caller owns it
  firm uuid := gen_random_uuid();      -- caller is a plain member
  dead uuid := gen_random_uuid();      -- soft-deleted below
  other uuid := gen_random_uuid();     -- caller is not a member
  other_project uuid := gen_random_uuid();
  owned_project uuid := gen_random_uuid();
  shared_project uuid := gen_random_uuid();
  team_project uuid := gen_random_uuid();
  private_project uuid := gen_random_uuid();
  opened_project uuid := gen_random_uuid();
  ownerless_project uuid := gen_random_uuid();
  archived_project uuid := gen_random_uuid();
  firm_public uuid := gen_random_uuid();
  firm_denied uuid := gen_random_uuid();
  firm_private_viewer uuid := gen_random_uuid();
  firm_private uuid := gen_random_uuid();
  caller_personal uuid;
  colleague_personal uuid;
  item uuid;
begin
  insert into auth.users(id,email) values
    (caller,caller||'@example.test'),
    (colleague,colleague||'@example.test'),
    (outsider,outsider||'@example.test'),
    (auditor,auditor||'@example.test'),
    (clerk,clerk||'@example.test');
  insert into actors values
    ('caller',caller::text,caller,caller||'@example.test'),
    ('caller-no-email',caller::text,caller,null),
    ('colleague',colleague::text,colleague,colleague||'@example.test'),
    ('auditor',auditor::text,auditor,auditor||'@example.test'),
    ('clerk',clerk::text,clerk,clerk||'@example.test'),
    ('outsider',outsider::text,outsider,outsider||'@example.test'),
    -- Not a uuid: reaches nothing by identity, but email grants still apply.
    ('legacy-id','legacy-user-42',null,caller||'@example.test');

  insert into organizations(id,name,created_by,kind) values
    (team,'Synthetic team',caller,'team'),
    (firm,'Synthetic firm',colleague,'team'),
    (dead,'Deleted firm',caller,'team'),
    (other,'Unrelated firm',outsider,'team');
  insert into org_members(org_id,user_id,role,can_access_private_content) values
    (team,caller,'owner',false),(team,colleague,'member',false),
    (team,auditor,'admin',true),(team,clerk,'admin',false),
    (firm,colleague,'owner',false),(firm,caller,'member',false),
    (dead,caller,'owner',false),
    (other,outsider,'owner',false);
  insert into workspaces values ('all',null),('personal','personal'),('team',team::text),('firm',firm::text),('other',other::text);

  -- Accounts get a personal organization on creation; make sure both exist.
  select id into caller_personal from organizations where personal_user_id=caller;
  if caller_personal is null then
    caller_personal := gen_random_uuid();
    insert into organizations(id,name,created_by,kind,personal_user_id)
      values(caller_personal,'Personal',caller,'personal',caller);
  end if;
  select id into colleague_personal from organizations where personal_user_id=colleague;
  if colleague_personal is null then
    colleague_personal := gen_random_uuid();
    insert into organizations(id,name,created_by,kind,personal_user_id)
      values(colleague_personal,'Personal',colleague,'personal',colleague);
  end if;

  insert into projects(id,user_id,org_id,name,visibility) values
    (owned_project,caller,null,'Owned','private'),
    (shared_project,outsider,null,'Shared','private'),
    (team_project,colleague,team,'Team','organization'),
    (private_project,colleague,team,'Private','private'),
    (opened_project,colleague,team,'Opened private','private'),
    (ownerless_project,outsider,team,'Ownerless','private'),
    (archived_project,caller,team,'Archived','organization'),
    (firm_public,colleague,firm,'Firm public','organization'),
    (firm_denied,colleague,firm,'Firm denied','organization'),
    (firm_private_viewer,colleague,firm,'Firm private, shared','private'),
    (firm_private,colleague,firm,'Firm private','private'),
    (other_project,outsider,other,'Unrelated matter','organization');
  update projects set archived_at=now() where id=archived_project;
  insert into project_access_grants(project_id,email,role,created_by)
    values(shared_project,caller||'@example.test','viewer',outsider);
  insert into project_org_access_overrides(project_id,org_id,user_id,role,assigned_by) values
    (firm_denied,firm,caller,'deny',colleague),
    (firm_private_viewer,firm,caller,'viewer',colleague);
  perform open_org_private_content(team,caller,'project',opened_project);

  -- 1,000 newer unrelated chats must not affect the caller's first page.
  insert into chats(user_id,title,updated_at)
    select outsider,'Unrelated',now()+interval '1 day' from generate_series(1,1000);

  -- Visible to the caller.
  insert into chats(user_id,title) values(caller,'Owned') returning id into item;
  insert into chat_cases values(item,'owned'); insert into expected_visible values('owned','owner');
  insert into chats(user_id,title) values(outsider,'Direct grant') returning id into item;
  insert into chat_cases values(item,'direct'); insert into expected_visible values('direct','editor');
  insert into chat_access_grants(chat_id,email,role,created_by)
    values(item,caller||'@example.test','editor',outsider);
  insert into chats(user_id,project_id,title)
    values(outsider,owned_project,'Owned project') returning id into item;
  insert into chat_cases values(item,'owned-project'); insert into expected_visible values('owned-project','owner');
  insert into chats(user_id,project_id,title)
    values(outsider,shared_project,'Shared project') returning id into item;
  insert into chat_cases values(item,'shared-project'); insert into expected_visible values('shared-project','viewer');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,team_project,team,'Team project') returning id into item;
  insert into chat_cases values(item,'team-project'); insert into expected_visible values('team-project','owner');
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Team direct grant') returning id into item;
  insert into chat_cases values(item,'team-direct'); insert into expected_visible values('team-direct','viewer');
  insert into chat_access_grants(chat_id,email,role,created_by)
    values(item,caller||'@example.test','viewer',colleague);
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Private audited') returning id into item;
  insert into chat_cases values(item,'audited'); insert into expected_visible values('audited','viewer');
  perform open_org_private_content(team,caller,'chat',item);
  perform open_org_private_content(team,auditor,'chat',item);
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,opened_project,team,'Opened private project') returning id into item;
  insert into chat_cases values(item,'audited-project'); insert into expected_visible values('audited-project','viewer');
  insert into chats(user_id,project_id,org_id,title)
    values(outsider,ownerless_project,team,'Ownerless project') returning id into item;
  insert into chat_cases values(item,'ownerless-project'); insert into expected_visible values('ownerless-project','owner');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,firm_public,firm,'Firm public') returning id into item;
  insert into chat_cases values(item,'firm-public'); insert into expected_visible values('firm-public','editor');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,firm_private_viewer,firm,'Firm private, shared') returning id into item;
  insert into chat_cases values(item,'firm-private-viewer'); insert into expected_visible values('firm-private-viewer','viewer');
  insert into chats(user_id,org_id,title)
    values(caller,caller_personal,'Personal organization') returning id into item;
  insert into chat_cases values(item,'personal-org'); insert into expected_visible values('personal-org','owner');
  insert into chats(user_id,org_id,title)
    values(colleague,colleague_personal,'Personal organization, shared') returning id into item;
  insert into chat_cases values(item,'personal-org-grant'); insert into expected_visible values('personal-org-grant','editor');
  insert into chat_access_grants(chat_id,email,role,created_by)
    values(item,caller||'@example.test','editor',colleague);

  -- Across organizations. A project chat cannot carry another organization
  -- than its project's: chats_sync_project_org restamps it on insert and
  -- update, so project access and the workspace filter always read the same
  -- organization. Documented here with deliberately wrong stamps.
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,team_project,firm,'Team project, stamped with the firm') returning id into item;
  insert into chat_cases values(item,'cross-org-project'); insert into expected_visible values('cross-org-project','owner');
  perform pg_temp.assert_true((select org_id=team from chats where id=item),'a project chat is restamped with its project''s organization');
  insert into chats(user_id,project_id,org_id,title)
    values(caller,owned_project,team,'Personal project, stamped with the team') returning id into item;
  insert into chat_cases values(item,'personal-project-team-stamp'); insert into expected_visible values('personal-project-team-stamp','owner');
  perform pg_temp.assert_true((select org_id is null from chats where id=item),'a personal project''s chat is restamped as personal');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,team_project,dead,'Team project, stamped with the deleted firm') returning id into item;
  insert into chat_cases values(item,'deleted-org-stamp'); insert into expected_visible values('deleted-org-stamp','owner');
  perform pg_temp.assert_true((select org_id=team from chats where id=item),'a dead organization''s stamp cannot stick to a live project''s chat');

  -- Hidden from the caller.
  insert into chats(user_id,project_id,org_id,title)
    values(caller,other_project,other,'Own chat in a foreign organization project') returning id into item;
  insert into chat_cases values(item,'creator-foreign-project-hidden');
  insert into chats(user_id,org_id,title)
    values(outsider,other,'Foreign team chat, shared by email') returning id into item;
  insert into chat_cases values(item,'foreign-team-grant-hidden');
  insert into chat_access_grants(chat_id,email,role,created_by)
    values(item,caller||'@example.test','editor',outsider);
  -- (A direct grant on an organization project is rejected by
  -- validate_direct_access_scope, so that cross-organization path cannot exist.)
  insert into chats(user_id,project_id,org_id,title)
    values(outsider,other_project,other,'Foreign organization project') returning id into item;
  insert into chat_cases values(item,'foreign-project-hidden');
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Private, opened under the wrong organization') returning id into item;
  insert into chat_cases values(item,'opened-wrong-org-hidden');
  insert into org_private_content_access(org_id,user_id,kind,item_id) values(firm,caller,'chat',item);
  insert into chats(user_id,org_id,title)
    values(colleague,team,'Private unopened') returning id into item;
  insert into chat_cases values(item,'private-hidden');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,private_project,team,'Private project unopened') returning id into item;
  insert into chat_cases values(item,'private-project-hidden');
  insert into chats(user_id,title,archived_at)
    values(caller,'Archived',now()) returning id into item;
  insert into chat_cases values(item,'archived-hidden');
  insert into chats(user_id,project_id,org_id,title)
    values(caller,archived_project,team,'In archived project') returning id into item;
  insert into chat_cases values(item,'archived-project-hidden');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,firm_denied,firm,'Firm denied') returning id into item;
  insert into chat_cases values(item,'firm-denied-hidden');
  insert into chats(user_id,project_id,org_id,title)
    values(colleague,firm_private,firm,'Firm private') returning id into item;
  insert into chat_cases values(item,'firm-private-hidden');
  insert into chats(user_id,org_id,title)
    values(caller,dead,'In deleted organization') returning id into item;
  insert into chat_cases values(item,'deleted-org-hidden');
  perform soft_delete_organization(dead,caller);

  -- An active user must not pay for every old chat to read a two-row page.
  with added as (
    insert into chats(user_id,title) select caller,'More owned chats' from generate_series(1,200)
    returning id
  ) insert into chat_cases select id,'more-owned' from added;
end;
$$;

-- The oracle: the per-row verdict, evaluated for every chat and every actor,
-- before that function is instrumented below.
create temporary table expected_chats as
select a.label as actor, c.id, c.updated_at, c.org_id, p.name as project_name,
       coalesce(c.user_id::text=a.uid,false) as is_owner,
       public.chat_access_role(c.id,c.user_id,c.project_id,c.org_id,a.uid,a.email) as access_role
from chats c left join projects p on p.id=c.project_id cross join actors a;

do $$
declare mismatches text;
begin
  -- The oracle itself must say what this file documents, so a change to the
  -- ladder shows up here as a changed expectation, not a silently moved target.
  select string_agg(format('%s: verdict %s, documented %s',k.label,coalesce(e.access_role,'hidden'),coalesce(v.role,'hidden')),'; ' order by k.label)
    into mismatches
    from chat_cases k
    left join expected_chats e on e.id=k.id and e.actor='caller'
    left join expected_visible v on v.label=k.label
    where k.label not in ('more-owned') and e.access_role is distinct from v.role;
  perform pg_temp.assert_true(mismatches is null,
    'chat_access_role grants the caller exactly the documented cases and roles: '||coalesce(mismatches,''));
  perform pg_temp.assert_true((select count(*)=216 from expected_chats where actor='caller' and access_role is not null),
    'fixture: 16 single cases plus 200 owned chats are visible to the caller');
  perform pg_temp.assert_true((select count(*)=1 from expected_chats e join chat_cases k on k.id=e.id
    where e.actor='auditor' and k.label='audited' and e.access_role='viewer'),
    'an admin allowed to open private content sees the chat they opened');
  perform pg_temp.assert_true((select count(*)=0 from expected_chats e join chat_cases k on k.id=e.id
    where e.actor='clerk' and k.label in ('audited','private-hidden') and e.access_role is not null),
    'an admin without that permission sees neither private chat');
  perform pg_temp.assert_true((select count(*)=0 from expected_chats e join chat_cases k on k.id=e.id
    where e.actor='outsider' and k.label in ('team-direct','firm-public','cross-org-project') and e.access_role is not null),
    'sharing never reaches outside the organization');
  perform pg_temp.assert_true((select count(*)=2 from expected_chats e join chat_cases k on k.id=e.id
    where e.actor='outsider' and k.label in ('creator-foreign-project-hidden','foreign-project-hidden') and e.access_role='owner'),
    'the foreign organization owner sees the chats in their own project');
end;
$$;

-- From here on, the per-row verdict is instrumented: the list must never
-- reach it, because that call per row is what timed GET /chat out.
alter function public.chat_access_role(uuid,uuid,uuid,uuid,text,text)
  rename to oracle_chat_access_role;
create function public.chat_access_role(
  p_chat_id uuid,p_chat_user_id uuid,p_project_id uuid,p_org_id uuid,p_user_id text,p_user_email text
) returns text language plpgsql as $$
begin
  perform nextval('pg_temp.role_calls');
  return public.oracle_chat_access_role(p_chat_id,p_chat_user_id,p_project_id,p_org_id,p_user_id,p_user_email);
end;
$$;

do $$
declare
  a record; w record; actual uuid[]; expected uuid[]; extra integer; missing integer; cursor_row record; n integer;
begin
  for a in select * from actors loop
    for w in select * from workspaces loop
      create temporary table overview as
        select * from get_chats_overview(a.uid,a.email,null,0,null,null,w.workspace);
      select array_agg(id order by updated_at desc,id) into actual from overview;
      select array_agg(id order by updated_at desc,id) into expected from expected_chats
        where actor=a.label and access_role is not null and workspace_matches(w.workspace,org_id);
      perform pg_temp.assert_true(actual is not distinct from expected,
        format('%s/%s: the list contains exactly the chats the verdict grants, in activity order',a.label,w.label));
      perform pg_temp.assert_true((select array_agg(id) from overview) is not distinct from actual,
        format('%s/%s: rows come back in activity order',a.label,w.label));
      select count(*) into extra from (
        select id,access_role,is_owner,project_name from overview
        except all
        select id,access_role,is_owner,project_name from expected_chats
          where actor=a.label and access_role is not null and workspace_matches(w.workspace,org_id)) d;
      select count(*) into missing from (
        select id,access_role,is_owner,project_name from expected_chats
          where actor=a.label and access_role is not null and workspace_matches(w.workspace,org_id)
        except all
        select id,access_role,is_owner,project_name from overview) d;
      perform pg_temp.assert_true(extra=0 and missing=0,
        format('%s/%s: role, provenance and project name match the verdict',a.label,w.label));
      drop table overview;
    end loop;
  end loop;

  -- Pagination, for the caller: offset, keyset cursor, clamping.
  select * into a from actors where label='caller';
  select array_agg(id order by updated_at desc,id) into expected from (
    select * from expected_chats where actor='caller' and access_role is not null
    order by updated_at desc,id limit 2 offset 1
  ) page;
  select array_agg(id) into actual from get_chats_overview(a.uid,a.email,2,1);
  perform pg_temp.assert_true(actual is not distinct from expected,'offset pagination parity');
  select * into cursor_row from expected_chats where actor='caller' and access_role is not null
    order by updated_at desc,id limit 1 offset 1;
  select array_agg(id order by updated_at desc,id) into expected from expected_chats
    where actor='caller' and access_role is not null
      and (updated_at<cursor_row.updated_at or (updated_at=cursor_row.updated_at and id>cursor_row.id));
  select array_agg(id) into actual
    from get_chats_overview(a.uid,a.email,null,0,cursor_row.updated_at,cursor_row.id);
  perform pg_temp.assert_true(actual is not distinct from expected,'cursor pagination parity');
  select count(*) into n from get_chats_overview(a.uid,a.email,500,0);
  perform pg_temp.assert_true(n=100,'a page is at most 100 rows');
  select count(*) into n from get_chats_overview(a.uid,a.email,0,-5);
  perform pg_temp.assert_true(n=1,'limit and offset are clamped to 1 and 0');
  select count(*) into n from get_chats_overview('not-a-user-id',null);
  perform pg_temp.assert_true(n=0,'an identifier that is not a uuid, without an email, reaches nothing');

  perform pg_temp.assert_true((select last_value=0 and not is_called from pg_temp.role_calls),
    'get_chats_overview never evaluates chat_access_role per row');
  perform pg_temp.assert_true(not has_table_privilege('authenticated','chats','SELECT'),
    'browser still cannot read backend-owned chats');
end;
$$;
rollback;
