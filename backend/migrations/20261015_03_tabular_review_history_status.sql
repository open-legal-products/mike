-- Migration date: 2026-10-15
-- Small, authorized status snapshots for sidebar rows, without document content.
create or replace function public.get_tabular_review_history_status(
  p_user_id text,
  p_user_email text,
  p_review_ids uuid[]
)
returns table (id uuid, is_running boolean, is_complete boolean)
language sql
stable
set search_path = public
as $$
  select tr.id,
    coalesce(tr.active_generation_id is not null and tr.generation_lease_expires_at > now(), false) as is_running,
    not coalesce(tr.active_generation_id is not null and tr.generation_lease_expires_at > now(), false)
      and jsonb_array_length(coalesce(tr.columns_config, '[]'::jsonb)) > 0
      and exists (select 1 from public.tabular_review_rows r where r.review_id = tr.id)
      and not exists (
        select 1
        from public.tabular_review_rows r
        cross join jsonb_array_elements(coalesce(tr.columns_config, '[]'::jsonb)) col
        where r.review_id = tr.id
          and not exists (
            select 1 from public.tabular_cells c
            where c.review_id = tr.id and c.row_id = r.id
              and c.column_index = (col->>'index')::integer
              and c.status = 'done' and c.content is not null
          )
      ) as is_complete
  from public.tabular_reviews tr
  where tr.id = any(p_review_ids)
    and public.review_access_role(
      tr.id, tr.user_id, tr.project_id, tr.org_id, p_user_id, p_user_email
    ) is not null;
$$;

revoke all on function public.get_tabular_review_history_status(text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_tabular_review_history_status(text, text, uuid[])
  to service_role;
