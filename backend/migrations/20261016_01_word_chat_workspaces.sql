-- Migration date: 2026-10-16
--
-- Word chats belong to a workspace, like a chat started on its own in the
-- web assistant (20261012_07_standalone_org_content.sql).
--
-- A Word chat was always Personal. One started while its author works in a
-- team organization's workspace now belongs to that organization: it runs on
-- the organization's keys and models, draws only on the organization's
-- documents and workflows, and learns into its author's memory FOR THAT
-- WORKSPACE. The organization is fixed when the chat is created.
--
--   word_chats.org_id                 null is Personal
--   memory_source_org_id()            gains the Word branch
--   memory_source_allows_app_memory() Word chats pass the same ownership and
--                                     membership test as standalone chats
--   purge_expired_organizations()     deletes the organization's Word chats
--
-- A Word chat is private to its author and is never shared, so nothing moves
-- when a member leaves: the chat stays with the organization and its author
-- loses access with their membership (checked on every request).
--
-- Existing rows keep a null org_id and stay Personal.
--
-- Safe to re-run: add column / create index if not exists, create or replace.

alter table public.word_chats
  add column if not exists org_id uuid
    references public.organizations(id) on delete restrict;

-- The task pane lists one document's chats in one workspace, newest first.
create index if not exists idx_word_chats_document_org_updated
  on public.word_chats(word_document_id, org_id, updated_at desc);

-- Purging an organization deletes its Word chats by organization.
create index if not exists idx_word_chats_org on public.word_chats(org_id);

-- The workspace a conversation's own-memory belongs to: the team
-- organization of a chat started on its own there, or of a Word chat started
-- there, otherwise null — Personal. A chat in a project and a tabular review
-- chat are never a workspace's: what they may learn is decided by
-- memory_source_allows_app_memory.
create or replace function public.memory_source_org_id(
  p_surface text,
  p_conversation_id uuid
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when p_surface = 'chat' then (
      select chat.org_id
      from public.chats chat
      where chat.id = p_conversation_id
        and chat.project_id is null
        and public.org_is_team(chat.org_id)
    )
    when p_surface = 'word' then (
      select chat.org_id
      from public.word_chats chat
      where chat.id = p_conversation_id
        and public.org_is_team(chat.org_id)
    )
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
  -- A Word chat is never shared and never in a project: it is a standalone
  -- chat that only its author, while still a member, can reach.
  select case
    when p_surface = 'word' then
      p_project_id is null
      and exists (
        select 1
        from public.word_chats chat
        where chat.id = p_conversation_id
          and chat.user_id = p_actor_user_id
          and (
            not public.org_is_team(chat.org_id)
            or exists (
              select 1 from public.active_org_members member
              where member.org_id = chat.org_id
                and member.user_id = p_actor_user_id
            )
          )
      )
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
    delete from public.word_chats where org_id=org.id;
    delete from public.memory_files where org_id=org.id;
    insert into public.audit_events(org_id,action,title,surface) values(org.id,'org.purged',org.name,'organization');
    delete from public.organizations where id=org.id;
    purged := purged+1;
  end loop;
  return purged;
end;
$$;
