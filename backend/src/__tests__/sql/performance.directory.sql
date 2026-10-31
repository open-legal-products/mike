-- H8: project selection precedes document hydration; permissions are shared
-- with project lists rather than reimplemented in a second policy ladder.
begin;
do $$
declare actor uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  p1 uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid(); hidden uuid:=gen_random_uuid();
  doc uuid; version uuid; result jsonb; body text; plan jsonb; hydrated numeric; expected uuid[]; actual uuid[]; scope text;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test'),(outsider,outsider||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Picker org',actor);
  insert into public.org_members(org_id,user_id,role) values(org,actor,'owner'),(org,outsider,'member');
  insert into public.projects(id,user_id,org_id,name,cm_number,updated_at) values
    (p1,actor,null,'Needle one',null,'2026-10-03'),(p2,actor,null,'Needle two',null,'2026-10-02'),
    (p3,actor,null,'Filename only',null,'2026-10-01'),(hidden,outsider,org,'Needle hidden',null,'2026-10-04');
  insert into public.projects(user_id,name,updated_at) select actor,'Needle off-page '||n,'2026-09-01' from generate_series(1,50) n;
  insert into public.documents(project_id,user_id) select p.id,actor from public.projects p cross join generate_series(1,20) n where p.user_id=actor;
  insert into public.document_versions(document_id,version_number,filename) select d.id,1,'Needle.docx' from public.documents d join public.projects p on p.id=d.project_id where p.user_id=actor;
  update public.documents d set current_version_id=v.id from public.document_versions v where v.document_id=d.id and d.user_id=actor;
  -- Version writes touch project activity. Restore deterministic project order.
  update public.projects set updated_at=case id when p1 then '2026-10-03'::timestamptz when p2 then '2026-10-02'::timestamptz when p3 then '2026-10-01'::timestamptz else '2026-09-01'::timestamptz end where user_id=actor;
  result:=public.search_project_directory(actor::text,actor||'@example.test','Needle',1,0,null);
  assert jsonb_array_length(result)=2,'limit plus sentinel project';
  assert result->0->>'id'=p1::text and result->1->>'id'=p2::text,'updated ordering';
  assert jsonb_array_length(result->0->'documents')=20 and result->0->'folders'='[]'::jsonb,'complete per-page matching documents and empty folders';
  result:=public.search_project_directory(actor::text,actor||'@example.test','Needle',1,2,null);
  assert result->0->>'id'=p3::text,'filename-only match remains searchable';
  assert not exists(select 1 from jsonb_array_elements(public.search_project_directory(actor::text,'','Needle',100,0,null)) p where p->>'id'=hidden::text),'organization ownership alone does not reveal private project';
  perform public.open_org_private_content(org,actor,'project',hidden);
  assert exists(select 1 from jsonb_array_elements(public.search_project_directory(actor::text,'','Needle',100,0,org::text)) p where p->>'id'=hidden::text),'explicit private opening is searchable';
  foreach scope in array array[null::text,'personal',org::text] loop
    select array_agg(project_id order by project_id) into expected from public.project_list_access(actor::text,actor||'@example.test',scope);
    select array_agg((p->>'id')::uuid order by (p->>'id')::uuid) into actual from jsonb_array_elements(public.search_project_directory(actor::text,actor||'@example.test','',100,0,scope)) p;
    assert actual is not distinct from expected,'directory uses the same workspace authorization set as project lists';
  end loop;
  assert public.search_project_directory(actor::text,'','%_',20,0,null)='[]'::jsonb,'wildcards are literal';
  select prosrc into body from pg_proc where oid='public.search_project_directory(text,text,text,integer,integer,text)'::regprocedure;
  body:=replace(replace(replace(replace(replace(replace(body,'p_user_id','$1'),'p_user_email','$2'),'p_search_term','$3'),'p_limit','$4'),'p_offset','$5'),'p_workspace','$6');
  execute 'explain (analyze,format json) '||body into plan using actor::text,actor||'@example.test','Needle'::text,1,0,'personal'::text;
  select max((v->>'Actual Rows')::numeric) into hydrated from jsonb_path_query(plan,'$.** ? (@."Subplan Name" == "CTE page_documents")') v;
  assert hydrated=40,'off-page documents must not enter the hydration CTE';
  assert not has_function_privilege('authenticated','public.search_project_directory(text,text,text,integer,integer,text)','EXECUTE'),'server-only actor boundary';
end;
$$;
rollback;
