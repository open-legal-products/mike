-- Run only on a disposable database after schema.sql / migrations.
-- All synthetic rows and temporary test triggers are rolled back.
\set ON_ERROR_STOP on
begin;
do $$
declare
  actor uuid := gen_random_uuid();
  org uuid := gen_random_uuid();
  book uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
  before_jobs integer;
begin
  insert into auth.users(id, email) values(actor, 'playbook-lifecycle@example.invalid');
  insert into public.organizations(id, name) values(org, 'Playbook lifecycle test');
  insert into public.playbooks(id, user_id, org_id, name, content_json, source_storage_key)
    values(book, actor, org, 'Lifecycle test', '{}', 'test/playbook-import.docx');
  insert into public.playbook_sources(id, playbook_id, filename, file_type, storage_key, size_bytes)
    values(source, book, 'Reference.pdf', 'pdf', 'test/playbook-reference.pdf', 1);
  select count(*) into before_jobs from public.db_jobs where kind = 'storage.cleanup';
  update public.playbooks set source_storage_key = source_storage_key where id = book;
  update public.playbook_sources set storage_key = storage_key where id = source;
  assert (select count(*) = before_jobs from public.db_jobs where kind = 'storage.cleanup'), 'unchanged keys do not retire live files';

  update public.playbooks set source_storage_key = 'test/playbook-replacement.docx' where id = book;
  update public.playbook_sources set storage_key = 'test/playbook-reference-new.pdf' where id = source;
  assert exists(select 1 from public.db_jobs where kind = 'storage.cleanup'
    and payload->'keys' = '["test/playbook-import.docx"]'), 'import replacement cleanup';
  assert exists(select 1 from public.db_jobs where kind = 'storage.cleanup'
    and payload->'keys' = '["test/playbook-reference.pdf"]'), 'reference replacement cleanup';
  delete from public.playbook_sources where id = source;
  assert exists(select 1 from public.db_jobs where kind = 'storage.cleanup'
    and payload->'keys' = '["test/playbook-reference-new.pdf"]'), 'reference deletion cleanup';

  insert into public.playbook_sources(playbook_id, filename, file_type, storage_key, size_bytes)
    values(book, 'Cascade.pdf', 'pdf', 'test/playbook-org-cascade.pdf', 1);
  delete from public.organizations where id = org;
  assert not exists(select 1 from public.playbooks where id = book), 'organization cascade';
  assert exists(select 1 from public.db_jobs where kind = 'storage.cleanup'
    and payload->'keys' = '["test/playbook-replacement.docx"]'), 'organization import cleanup';
  assert exists(select 1 from public.db_jobs where kind = 'storage.cleanup'
    and payload->'keys' = '["test/playbook-org-cascade.pdf"]'), 'organization reference cleanup';

  insert into public.playbooks(id, user_id, name, content_json)
    values(book, actor, 'Personal playbook', '{}');
  insert into public.playbook_sources(playbook_id, filename, file_type, storage_key, size_bytes)
    values(book, 'Personal.pdf', 'pdf', 'test/playbook-account-cascade.pdf', 1);
  delete from auth.users where id = actor;
  assert not exists(select 1 from public.playbooks where id = book), 'account cascade';
  assert exists(select 1 from public.db_jobs where kind = 'storage.cleanup'
    and payload->'keys' = '["test/playbook-account-cascade.pdf"]'), 'account reference cleanup';
  assert not has_function_privilege('authenticated', 'public.queue_playbook_storage_cleanup()', 'EXECUTE'), 'authenticated privilege';
  assert not has_function_privilege('anon', 'public.queue_playbook_storage_cleanup()', 'EXECUTE'), 'anonymous privilege';
end;
$$;

-- A failed cleanup enqueue must roll back deletion and all its cascades.
create function pg_temp.reject_playbook_cleanup() returns trigger language plpgsql as $$
begin
  if new.kind = 'storage.cleanup' then raise exception 'cleanup_insert_rejected'; end if;
  return new;
end;
$$;
create trigger playbook_test_reject_cleanup before insert on public.db_jobs
for each row execute function pg_temp.reject_playbook_cleanup();
do $$
declare
  actor uuid := gen_random_uuid();
  book uuid := gen_random_uuid();
  source uuid := gen_random_uuid();
begin
  insert into auth.users(id, email) values(actor, 'playbook-rollback@example.invalid');
  insert into public.playbooks(id, user_id, name, content_json)
    values(book, actor, 'Rollback test', '{}');
  insert into public.playbook_sources(id, playbook_id, filename, file_type, storage_key, size_bytes)
    values(source, book, 'Retained.pdf', 'pdf', 'test/playbook-retained.pdf', 1);
  begin
    delete from public.playbooks where id = book;
    raise exception 'delete committed without cleanup';
  exception when raise_exception then
    if sqlerrm <> 'cleanup_insert_rejected' then raise; end if;
  end;
  assert exists(select 1 from public.playbooks where id = book), 'parent deletion rolls back';
  assert exists(select 1 from public.playbook_sources where id = source), 'source deletion rolls back';
end;
$$;
rollback;
\echo Playbook storage cleanup transaction checks passed.
