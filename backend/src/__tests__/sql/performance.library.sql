-- C4: a personal Library lookup should probe the UUID owner index.
begin;
do $$
declare actor uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  body text; plan jsonb; fetched numeric;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test'),(outsider,outsider||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Other workspace',actor);
  insert into public.org_members(org_id,user_id,role) values(org,actor,'owner');
  insert into public.documents(user_id,library_kind) values(actor,'file'),(actor,'file'),(actor,'template');
  insert into public.documents(user_id,org_id,library_kind) values(actor,org,'file');
  insert into public.documents(user_id,library_kind) select outsider,'file' from generate_series(1,10000);
  analyze public.documents;
  assert (select count(*)=2 from public.search_library_documents(actor::text,'file',20,0,null,null,'updated','desc','personal')), 'personal owner and kind scope';
  assert (select count(*)=1 from public.get_library_document_ids(actor::text,'file',null,null,20,0,org::text)), 'organization workspace scope';
  assert (select count(*)=0 from public.get_library_document_ids('malformed','file',null,null,20,0)), 'malformed owner is denied without a cast error';
  select prosrc into body from pg_proc where oid='public.search_library_documents(text,text,integer,integer,text,text,text,text,text)'::regprocedure;
  body:=replace(replace(replace(replace(replace(replace(replace(replace(replace(body,
    'p_user_id',quote_literal(actor::text)),'p_library_kind',quote_literal('file')),'p_limit','20'),'p_offset','0'),
    'p_search_term','null::text'),'p_file_type','null::text'),'p_sort_key',quote_literal('updated')),
    'p_sort_direction',quote_literal('desc')),'p_workspace','$1');
  execute 'explain (analyze,format json) '||body into plan using 'personal'::text;
  select coalesce(sum((v->>'Actual Rows')::numeric*(v->>'Actual Loops')::numeric),0) into fetched
    from jsonb_path_query(plan,'$.** ? (@."Relation Name" == "documents")') v;
  assert fetched<20,'library lookup scanned unrelated owners';
  assert jsonb_path_exists(plan,'$.**."Index Cond"'),'owner lookup must use an equality index condition';
end;
$$;
rollback;
