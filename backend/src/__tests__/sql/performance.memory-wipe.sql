-- wipe_memory_files: one round trip for an erasure loop, with exactly the
-- per-file effect, result and errors of wipe_memory_file.
begin;
create temporary table wipe_files(id uuid,epoch bigint,revision bigint,enabled boolean);
do $$
declare person uuid;
begin
  for person in select gen_random_uuid() from generate_series(1,3) loop
    insert into auth.users(id,email) values(person,person||'@example.test');
    -- Accounts get their Personal memory file on creation.
    if not exists(select 1 from public.memory_files where user_id=person) then
      insert into public.memory_files(scope,user_id) values('user',person);
    end if;
    update public.memory_files set content='remembered',size_bytes=10,epoch=4,revision=7,enabled=true where user_id=person;
  end loop;
  insert into wipe_files select id,epoch,revision,enabled from public.memory_files where content='remembered';
end;
$$;
do $$
declare result jsonb; expected jsonb; ids uuid[]:=array(select id from wipe_files);
begin
  -- Duplicates are wiped once; rows come back in id order.
  select jsonb_agg(jsonb_build_array(memory_file_id,new_epoch,new_revision,effective_enabled,mutation_by)) into result
    from public.wipe_memory_files(ids||ids[1],false,null,'wipe');
  select jsonb_agg(jsonb_build_array(id,epoch+1,revision+1,false,null) order by id) into expected from wipe_files;
  assert result=expected,format('batch results %s, expected %s',result,expected);
  assert (select bool_and(m.content='' and m.size_bytes=0 and m.epoch=w.epoch+1 and m.revision=w.revision+1
      and not m.enabled and m.status='idle' and m.last_source='wipe')
    from public.memory_files m join wipe_files w on w.id=m.id),'each file wiped exactly as wipe_memory_file does';
  -- A null p_enabled keeps each file's setting, as the single function does.
  select jsonb_agg(effective_enabled) into result from public.wipe_memory_files(ids,null,null,'settings');
  assert result='[false,false,false]','null enabled keeps the current setting';
  -- Errors are the single function's, and roll back the whole batch.
  begin
    perform public.wipe_memory_files(ids||gen_random_uuid(),true,null,'wipe');
    raise exception 'missing id accepted';
  exception when sqlstate 'P0002' then null;
  end;
  assert (select bool_and(not enabled) from public.memory_files where id=any(ids)),'a failed batch changes nothing';
  begin
    perform public.wipe_memory_files(ids,true,null,'other');
    raise exception 'invalid source accepted';
  exception when sqlstate '22023' then null;
  end;
  assert not has_function_privilege('authenticated','public.wipe_memory_files(uuid[],boolean,uuid,text)','EXECUTE'),'service-only';
  assert has_function_privilege('service_role','public.wipe_memory_files(uuid[],boolean,uuid,text)','EXECUTE'),'service role may call it';
end;
$$;
rollback;
