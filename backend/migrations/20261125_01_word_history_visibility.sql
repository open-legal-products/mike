-- Migration date: 2026-11-25
-- Filter legacy Word chat lists by current workspace membership before paging.
create or replace function public.word_list_visible_chats(
  p_user_id uuid,
  p_document_id uuid,
  p_limit integer,
  p_offset integer
)
returns table (
  id uuid,
  user_id uuid,
  org_id uuid,
  title text,
  model text,
  reasoning_level text,
  created_at timestamptz,
  updated_at timestamptz
)
language sql stable set search_path = public, pg_temp as $$
  select c.id, c.user_id, c.org_id, c.title, c.model, c.reasoning_level,
         c.created_at, c.updated_at
  from public.word_chats c
  where c.word_document_id = p_document_id
    and c.user_id = p_user_id
    and (
      c.org_id is null
      or exists (
        select 1 from public.active_org_members m
        where m.org_id = c.org_id and m.user_id = p_user_id
      )
    )
  order by c.updated_at desc, c.id desc
  limit greatest(1, least(p_limit, 100)) offset greatest(0, p_offset)
$$;
revoke all on function public.word_list_visible_chats(uuid, uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.word_list_visible_chats(uuid, uuid, integer, integer) to service_role;
