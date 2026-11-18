-- Revision tokens must change for every cell write, including edits within one transaction.
begin;
do $$
declare
  owner_id uuid := gen_random_uuid();
  outsider_id uuid := gen_random_uuid();
  review_id uuid := gen_random_uuid();
  row_id uuid := gen_random_uuid();
  cell_id uuid := gen_random_uuid();
  original_revision uuid;
  edited_revision uuid;
  actual record;
begin
  insert into auth.users(id, email)
    values (owner_id, owner_id || '@example.test'), (outsider_id, outsider_id || '@example.test');
  insert into public.tabular_reviews(id, user_id, title, columns_config)
    values (review_id, owner_id, 'Cache regression', '[{"index":0,"name":"Term"}]');
  insert into public.tabular_review_rows(id, review_id, label, row_type)
    values (row_id, review_id, 'Synthetic source', 'document');
  insert into public.tabular_cells(id, review_id, row_id, column_index, content, status)
    values (cell_id, review_id, row_id, 0, '{"summary":"First"}', 'done')
    returning cache_revision into original_revision;
  assert original_revision <> '00000000-0000-0000-0000-000000000000'::uuid;
  update public.tabular_cells set content = '{"summary":"Second"}' where id = cell_id
    returning cache_revision into edited_revision;
  assert edited_revision <> original_revision, 'content update must invalidate the cached cell';
  update public.tabular_cells set status = 'pending' where id = cell_id;
  assert (select cache_revision <> edited_revision from public.tabular_cells where id = cell_id),
    'status-only updates within the same transaction must invalidate';
  delete from public.tabular_cells where id = cell_id;
  insert into public.tabular_cells(id, review_id, row_id, column_index, status)
    values (cell_id, review_id, row_id, 0, 'pending');
  assert (select cache_revision <> original_revision from public.tabular_cells where id = cell_id),
    'recreated cells must not reuse a prior revision';
  select * into actual from public.get_tabular_review_history_status(owner_id::text, null, array[review_id]);
  assert actual.id = review_id and actual.title = 'Cache regression' and actual.updated_at is not null;
  assert not actual.is_complete and not actual.is_running;
  assert (select count(*) = 0 from public.get_tabular_review_history_status(outsider_id::text, null, array[review_id])),
    'status metadata must preserve review authorization';
  assert not has_function_privilege('authenticated', 'public.get_tabular_review_history_status(text,text,uuid[])', 'execute');
end;
$$;
rollback;
