-- Migration date: 2026-09-21

alter table public.chats
  add column if not exists updated_at timestamptz;

update public.chats chat
set updated_at = greatest(
  chat.created_at,
  coalesce(
    (
      select max(message.created_at)
      from public.chat_messages message
      where message.chat_id = chat.id
    ),
    chat.created_at
  )
)
where chat.updated_at is null;

alter table public.chats
  drop constraint if exists chats_updated_at_not_null_check,
  add constraint chats_updated_at_not_null_check
    check (updated_at is not null) not valid;

alter table public.chats
  validate constraint chats_updated_at_not_null_check;

alter table public.chats
  alter column updated_at set default now(),
  alter column updated_at set not null;

alter table public.chats
  drop constraint chats_updated_at_not_null_check;

drop index concurrently if exists public.chats_user_updated_idx;
create index concurrently if not exists chats_updated_at_idx
  on public.chats(updated_at desc, id);

create or replace function public.set_chat_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists chats_set_updated_at on public.chats;
create trigger chats_set_updated_at
before update of title, model, reasoning_level on public.chats
for each row execute function public.set_chat_updated_at();

create or replace function public.touch_chat_from_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.chats
  set updated_at = now()
  where id = new.chat_id;
  return new;
end;
$$;

drop trigger if exists chat_messages_touch_chat on public.chat_messages;
create trigger chat_messages_touch_chat
after insert or update of content, files, workflow, citations
on public.chat_messages
for each row execute function public.touch_chat_from_message();

drop function if exists public.get_chats_overview(text, text, integer, integer);
drop function if exists public.get_chats_overview(text, text, integer, integer, timestamptz, uuid);
create or replace function public.get_chats_overview(
  p_user_id text,
  p_user_email text,
  p_limit integer default null,
  p_offset integer default 0,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null
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
