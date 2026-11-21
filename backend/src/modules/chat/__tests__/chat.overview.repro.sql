-- Reproduction of MIKE-BACKEND-F (GET /chat 500, PostgreSQL 57014 statement
-- cancelled; MIKE-FRONTEND-C in the browser) and confirmation of the fix.
-- Run with psql -v ON_ERROR_STOP=1 against a migrated LOCAL test database
-- (CI: .github/workflows/schema-drift.yml). Transactional; everything rolls back.
--
-- Shape of the failing installation: one busy team with 100,000 chats, all
-- more recent than the caller's own. The caller is not a member of that team
-- and asks for the first page of their chat list, as the sidebar does
-- (limit 11, no cursor). The query that shipped evaluated chat_access_role()
-- for every newer chat before it reached the caller's, so under an ordinary
-- statement_timeout the page never came back. The fixed query reaches the
-- caller's chats through indexes and returns the same page immediately.
begin;
set local statement_timeout = 0;
create function pg_temp.assert_true(value boolean, message text)
returns void language plpgsql as $$
begin
  if value is distinct from true then raise exception '%', message; end if;
end;
$$;

-- The query as it shipped, verbatim from schema.sql before this change.
create function pg_temp.get_chats_overview_before(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null,
  p_workspace text default null
)
returns table (
  id uuid,
  project_id uuid,
  user_id text,
  title text,
  model text,
  created_at timestamptz,
  updated_at timestamptz,
  project_name text,
  is_owner boolean,
  access_role text
)
language sql
stable
set search_path = public
as $$
  select
    c.id,
    c.project_id,
    c.user_id::text as user_id,
    c.title,
    c.model,
    c.created_at,
    c.updated_at,
    p.name as project_name,
    -- Provenance ("I started this thread"), not a role: the ladder itself is
    -- lib/permissions.ts, and the creator branch of ensureChatAccess is what
    -- turns this into Owner standing.
    coalesce(c.user_id::text = p_user_id, false) as is_owner,
    -- The SAME verdict the predicate below filters on, served to the caller.
    -- Serving only is_owner was not enough: the client must distinguish
    -- Editor and Viewer from Owner so its actions match the server verdict.
    -- One evaluation, one truth: the lateral computes the role once and both
    -- the column and the WHERE read it.
    verdict.role as access_role
  from public.chats c
  left join public.projects p on p.id = c.project_id
  cross join lateral (
    select public.chat_access_role(
             c.id,
             c.user_id,
             c.project_id,
             c.org_id,
             p_user_id,
             p_user_email
           ) as role
  ) verdict
  -- The whole predicate, in one call.
  -- The join above is for project_name only; the function resolves the
  -- project itself.
  where verdict.role is not null
    and public.workspace_matches(p_workspace, c.org_id)
    and (
      p_before_updated_at is null
      or c.updated_at < p_before_updated_at
      or (c.updated_at = p_before_updated_at and c.id > p_before_id)
    )
  order by c.updated_at desc, c.id asc
  limit case
    when p_limit is null then null
    else greatest(1, least(p_limit, 100))
  end
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create temporary table repro (caller uuid, email text, expected uuid[]);
do $$
declare
  caller uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  busy uuid := gen_random_uuid();
begin
  insert into auth.users(id,email) values
    (caller,caller||'@example.test'),(other,other||'@example.test');
  insert into organizations(id,name,created_by,kind) values(busy,'Busy team',other,'team');
  insert into org_members(org_id,user_id,role) values(busy,other,'owner');
  -- The caller's chats: a quiet account, last active a week ago.
  insert into chats(user_id,title,updated_at)
    select caller,'Mine '||n,now()-interval '7 days'+(n||' minutes')::interval from generate_series(1,20) n;
  -- Everyone else's: the busy team, all more recent.
  insert into chats(user_id,org_id,title,updated_at)
    select other,busy,'Busy '||n,now()-interval '6 days'+(n||' seconds')::interval from generate_series(1,100000) n;
  analyze chats; analyze org_members; analyze organizations;
  insert into repro
    select caller,caller||'@example.test',
           array(select id from chats where user_id=caller order by updated_at desc,id limit 11);
end;
$$;

-- What a community install allows one statement. The sidebar's first-page
-- request has to finish inside it.
set local statement_timeout = '2s';
do $$
declare
  r record; started timestamptz; before_elapsed interval; after_elapsed interval;
  page uuid[]; cancelled boolean := false; sqlstate_seen text;
begin
  select * into r from repro;

  -- Replication: the shipped query does not finish.
  started := clock_timestamp();
  begin
    select array_agg(id order by updated_at desc,id) into page
      from pg_temp.get_chats_overview_before(r.caller::text,r.email,11,0,null,null,null);
  exception when query_canceled then
    cancelled := true; sqlstate_seen := sqlstate;
  end;
  before_elapsed := clock_timestamp()-started;
  perform pg_temp.assert_true(cancelled,
    format('the reproduction did not reproduce: the shipped query returned its page in %s',before_elapsed));
  perform pg_temp.assert_true(sqlstate_seen='57014','the cancellation is PostgreSQL 57014, as in MIKE-BACKEND-F');

  -- Confirmation: the fixed query returns the right page, within the same budget.
  -- (The timer has fired for this statement; the elapsed time is asserted directly.)
  started := clock_timestamp();
  select array_agg(id order by updated_at desc,id) into page
    from public.get_chats_overview(r.caller::text,r.email,11,0,null,null,null);
  after_elapsed := clock_timestamp()-started;
  perform pg_temp.assert_true(page=r.expected,'the fixed query returns the caller''s newest eleven chats');
  perform pg_temp.assert_true(after_elapsed<interval '2 seconds',
    format('the fixed query must finish within the statement timeout; took %s',after_elapsed));
  raise notice 'MIKE-BACKEND-F reproduction: shipped query cancelled (57014) after %; fixed query returned the page in %',
    date_trunc('milliseconds',before_elapsed), date_trunc('milliseconds',after_elapsed);
end;
$$;
rollback;
