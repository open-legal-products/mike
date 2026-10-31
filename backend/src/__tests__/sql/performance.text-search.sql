-- H4: a project text search authorizes its shared container once.
begin;
create temporary sequence search_project_calls minvalue 0 start 0;
do $$
declare actor uuid:=gen_random_uuid(); project uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  insert into public.projects(id,user_id,name) values(project,actor,'Search batch');
  insert into public.documents(project_id,user_id) select project,actor from generate_series(1,100);
  insert into public.document_versions(document_id,version_number,filename) select id,1,'Synthetic.pdf' from public.documents where project_id=project;
  update public.documents d set current_version_id=v.id from public.document_versions v where v.document_id=d.id and d.project_id=project;
  perform set_config('mike.test_search_actor',actor::text,true);perform set_config('mike.test_search_project',project::text,true);
end;
$$;
alter function public.project_access_role(uuid,uuid,uuid,text,text) rename to search_project_oracle;
create function public.project_access_role(p_project_id uuid,p_project_user_id uuid,p_org_id uuid,p_user_id text,p_user_email text)
returns text language plpgsql set search_path=public as $$
begin perform nextval('pg_temp.search_project_calls');return public.search_project_oracle(p_project_id,p_project_user_id,p_org_id,p_user_id,p_user_email);end;
$$;
do $$
declare result jsonb;
begin
  result:=public.find_document_text(current_setting('mike.test_search_actor'),'','personal','project','clause',current_setting('mike.test_search_project')::uuid);
  assert result#>>'{coverage,total_versions}'='100','all authorized versions remain in coverage';
  assert (select last_value=0 and is_called from pg_temp.search_project_calls),'one permission call per project search';
end;
$$;
rollback;
\ir ../../modules/documents/__tests__/documents.textSearch.sql
