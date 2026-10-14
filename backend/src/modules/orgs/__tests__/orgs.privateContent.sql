-- Run against a migrated LOCAL database with psql -v ON_ERROR_STOP=1 -f ... .
-- All fixtures and the simulated audit failure are rolled back, even on error.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end; $$;
create function pg_temp.fail_private_audit() returns trigger language plpgsql as $$
begin if new.action='org.private_content.opened' then raise exception 'synthetic audit failure'; end if; return new; end; $$;

do $$
declare
  owner_id uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); outsider_id uuid:=gen_random_uuid();
  org uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid(); personal_org uuid;
  project uuid:=gen_random_uuid(); workflow uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); review uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid();
  personal_doc uuid:=gen_random_uuid(); foreign_doc uuid:=gen_random_uuid(); attached_doc uuid:=gen_random_uuid();
  item record; before_count integer;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(admin_id,admin_id||'@example.test'),(member_id,member_id||'@example.test'),(outsider_id,outsider_id||'@example.test');
  insert into public.organizations(id,name,created_by,kind) values(org,'Private access test',owner_id,'team'),(other_org,'Other organization',outsider_id,'team');
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,admin_id,'admin'),(org,member_id,'member'),(other_org,outsider_id,'owner');
  select id into personal_org from public.organizations where kind='personal' and created_by=member_id limit 1;
  perform pg_temp.assert_true(personal_org is not null,'fixture has a personal workspace');
  insert into public.projects(id,org_id,user_id,name) values(project,org,member_id,'Private project');
  insert into public.workflows(id,org_id,user_id,title,type) values(workflow,org,member_id,'Private workflow','assistant');
  insert into public.chats(id,org_id,user_id,title) values(chat,org,member_id,'Private chat');
  insert into public.documents(id,org_id,user_id) values(doc,org,member_id),(personal_doc,personal_org,member_id),(foreign_doc,other_org,outsider_id),(attached_doc,org,member_id);
  insert into public.tabular_reviews(id,org_id,user_id,title,document_ids) values(review,org,member_id,'Private review',jsonb_build_array(attached_doc::text,personal_doc::text,foreign_doc::text));

  perform pg_temp.assert_true(can_access_org_private_content(org,owner_id),'owners have permission');
  perform pg_temp.assert_true(not can_access_org_private_content(org,admin_id),'admins default off');
  perform pg_temp.assert_true(not can_access_org_private_content(org,member_id),'members excluded');
  perform pg_temp.assert_true(not can_access_org_private_content(personal_org,member_id),'personal owners excluded');
  perform pg_temp.assert_true(project_access_role(project,member_id,org,owner_id::text,'') is null,'permission alone never opens a project');
  perform pg_temp.assert_true(not org_private_document_access(org,doc,owner_id::text),'permission alone never opens a document');
  begin perform list_org_private_content(org,admin_id); raise exception 'admin listed without permission'; exception when insufficient_privilege then null; end;
  begin perform open_org_private_content(org,admin_id,'document',doc); raise exception 'admin opened without permission'; exception when insufficient_privilege then null; end;
  begin perform set_org_private_content_permission(org,admin_id,admin_id,true); raise exception 'admin self granted'; exception when insufficient_privilege then null; end;
  begin perform set_org_private_content_permission(org,owner_id,member_id,true); raise exception 'member permission allowed'; exception when check_violation then null; end;
  begin perform set_org_private_content_permission(other_org,owner_id,outsider_id,true); raise exception 'cross organization permission allowed'; exception when insufficient_privilege then null; end;
  perform set_org_private_content_permission(org,owner_id,admin_id,true);
  perform pg_temp.assert_true(can_access_org_private_content(org,admin_id),'owner enables an admin');
  perform pg_temp.assert_true((select count(*)=6 from list_org_private_content(org,admin_id)),'catalog contains only organization items');
  perform pg_temp.assert_true((select count(*)=0 from list_org_private_content(org,admin_id,50,0,'%')),'search percent is literal');
  perform pg_temp.assert_true((select count(*)=1 from list_org_private_content(org,admin_id,50,0,'CHAT')),'search ignores case');
  begin perform open_org_private_content(org,admin_id,'document',personal_doc); raise exception 'personal document opened'; exception when no_data_found then null; end;
  begin perform open_org_private_content(org,admin_id,'document',foreign_doc); raise exception 'foreign document opened'; exception when no_data_found then null; end;
  begin perform open_org_private_content(personal_org,member_id,'document',personal_doc); raise exception 'personal workspace catalog accepted'; exception when no_data_found then null; end;

  for item in select * from (values('project',project),('workflow',workflow),('chat',chat),('tabular_review',review),('document',doc)) as items(kind,id) loop
    perform open_org_private_content(org,admin_id,item.kind,item.id);
    perform pg_temp.assert_true(org_private_access_role(org,item.kind,item.id,admin_id::text)='viewer','all kinds grant only viewer');
  end loop;
  perform pg_temp.assert_true(project_access_role(project,member_id,org,admin_id::text,'')='viewer','project SQL role matches opening');
  perform pg_temp.assert_true(workflow_access_role(workflow,member_id,org,admin_id::text,'')='viewer','workflow SQL role matches opening');
  perform pg_temp.assert_true(chat_access_role(chat,member_id,null,org,admin_id::text,'')='viewer','chat SQL role matches opening');
  perform pg_temp.assert_true(review_access_role(review,member_id,null,org,admin_id::text,'')='viewer','review SQL role matches opening');
  perform pg_temp.assert_true(org_private_document_access(org,doc,admin_id::text),'document SQL role matches opening');
  perform pg_temp.assert_true(org_private_document_access(org,attached_doc,admin_id::text),'referenced organization file readable');
  perform pg_temp.assert_true(not org_private_document_access(org,personal_doc,admin_id::text),'referenced personal file excluded');
  perform pg_temp.assert_true(not org_private_document_access(org,foreign_doc,admin_id::text),'referenced foreign file excluded');
  perform pg_temp.assert_true((select count(*)=5 from list_org_private_content_access(array[org],admin_id::text)),'directory verdict includes explicit openings');
  perform pg_temp.assert_true((select count(*)=5 from audit_events where org_id=org and action='org.private_content.opened'),'each open is audited');
  perform pg_temp.assert_true((select count(*)=1 from audit_events where org_id=org and action='org.private_content.permission_changed'),'permission is audited');
  perform close_org_private_content(org,admin_id,'document',doc);
  perform pg_temp.assert_true(not org_private_document_access(org,doc,admin_id::text),'end access revokes standalone file');
  perform pg_temp.assert_true((select count(*)=1 from audit_events where org_id=org and action='org.private_content.closed'),'end access is audited');

  perform set_org_private_content_permission(org,owner_id,admin_id,false);
  perform pg_temp.assert_true((select count(*)=0 from org_private_content_access where org_id=org and user_id=admin_id),'permission revocation deletes all grants');
  perform pg_temp.assert_true((select count(*)=0 from organization_audit_events(org,admin_id,'') where action='org.private_content.opened' and user_id<>admin_id and title is not null),'unprivileged admins see no other private titles');
  perform set_org_private_content_permission(org,owner_id,admin_id,true);
  perform pg_temp.assert_true(project_access_role(project,member_id,org,admin_id::text,'') is null,'re-enabled admin must reopen');
  perform open_org_private_content(org,admin_id,'project',project);
  update org_members set role='member' where org_id=org and user_id=admin_id;
  update org_members set role='admin' where org_id=org and user_id=admin_id;
  perform pg_temp.assert_true(not can_access_org_private_content(org,admin_id),'promotion does not restore permission');
  perform pg_temp.assert_true((select count(*)=0 from org_private_content_access where org_id=org),'demotion deletes openings');

  perform open_org_private_content(org,owner_id,'document',doc);
  update documents set archived_at=now() where id=doc;
  perform pg_temp.assert_true(not org_private_document_access(org,doc,owner_id::text),'archive immediately denies');
  update documents set archived_at=null where id=doc;
  perform pg_temp.assert_true(not org_private_document_access(org,doc,owner_id::text),'restore does not resurrect opening');
  perform open_org_private_content(org,owner_id,'document',doc);
  update documents set org_id=other_org where id=doc;
  perform pg_temp.assert_true(not org_private_document_access(org,doc,owner_id::text),'moving out revokes');
  update documents set org_id=org where id=doc;
  perform pg_temp.assert_true(not org_private_document_access(org,doc,owner_id::text),'moving back does not resurrect opening');

  -- An audit write failure must roll back the opening, not merely log a warning.
  execute 'create trigger synthetic_private_audit_failure before insert on public.audit_events for each row execute function pg_temp.fail_private_audit()';
  select count(*) into before_count from audit_events where org_id=org;
  begin
    perform open_org_private_content(org,owner_id,'document',doc);
    raise exception 'audit failure did not abort';
  exception when raise_exception then
    if sqlerrm<>'synthetic audit failure' then raise; end if;
  end;
  perform pg_temp.assert_true(not org_private_document_access(org,doc,owner_id::text),'audit failure rolls grant back');
  perform pg_temp.assert_true((select count(*)=before_count from audit_events where org_id=org),'audit failure leaves no partial event');
  execute 'drop trigger synthetic_private_audit_failure on public.audit_events';

  perform open_org_private_content(org,owner_id,'project',project);
  update organizations set deleted_at=now(),purge_after=now()+interval '30 days' where id=org;
  update organizations set deleted_at=null,purge_after=null where id=org;
  perform pg_temp.assert_true(project_access_role(project,member_id,org,owner_id::text,'') is null,'organization restore does not resurrect grants');
  perform set_org_private_content_permission(org,owner_id,admin_id,true);
  perform open_org_private_content(org,admin_id,'project',project);
  delete from org_members where org_id=org and user_id=admin_id;
  perform pg_temp.assert_true((select count(*)=0 from org_private_content_access where org_id=org and user_id=admin_id),'departure deletes grants');

  perform pg_temp.assert_true(not has_table_privilege('authenticated','org_private_content_access','INSERT'),'browser cannot self grant');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','open_org_private_content(uuid,uuid,text,uuid)','EXECUTE'),'browser cannot impersonate actor');
  perform pg_temp.assert_true(not has_function_privilege('anon','list_org_private_content(uuid,uuid,integer,integer,text)','EXECUTE'),'anonymous cannot list');
  perform pg_temp.assert_true(has_function_privilege('service_role','open_org_private_content(uuid,uuid,text,uuid)','EXECUTE'),'server can call RPC');
end; $$;
rollback;
