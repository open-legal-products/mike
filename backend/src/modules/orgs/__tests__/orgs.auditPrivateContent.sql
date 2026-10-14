-- Synthetic, rollback-only coverage of discovery through audit events.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end; $$;
do $$
declare
  owner_id uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid();
  org uuid:=gen_random_uuid(); personal_org uuid; other_org uuid:=gen_random_uuid();
  project uuid:=gen_random_uuid(); workflow uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); review uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid();
  child_doc uuid:=gen_random_uuid(); child_chat uuid:=gen_random_uuid(); child_review uuid:=gen_random_uuid();
  event_id uuid; item record; shown public.audit_events;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(admin_id,admin_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into organizations(id,name,created_by,kind) values(org,'Audit access fixture',owner_id,'team'),(other_org,'Other fixture',member_id,'team');
  insert into org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,admin_id,'admin'),(org,member_id,'member');
  select id into personal_org from organizations where kind='personal' and created_by=member_id;
  insert into projects(id,org_id,user_id,name) values(project,org,member_id,'Private project');
  insert into workflows(id,org_id,user_id,title,type) values(workflow,org,member_id,'Private workflow','assistant');
  insert into chats(id,org_id,user_id,title,project_id) values(chat,org,member_id,'Private chat',null),(child_chat,org,member_id,'Project chat',project);
  insert into documents(id,org_id,user_id,project_id) values(doc,org,member_id,null),(child_doc,org,member_id,project);
  insert into tabular_reviews(id,org_id,user_id,title,project_id) values(review,org,member_id,'Private review',null),(child_review,org,member_id,'Project review',project);

  for item in select * from (values('project',project),('workflow',workflow),('chat',chat),('tabular_review',review),('document',doc)) as items(kind,id) loop
    event_id:=gen_random_uuid();
    insert into audit_events(id,org_id,user_id,action,title,project_id,chat_id,review_id,document_id,detail)
      values(event_id,org,member_id,'fixture.event','Private item',
        case when item.kind='project' then item.id end,
        case when item.kind='chat' then item.id end,
        case when item.kind='tabular_review' then item.id end,
        case when item.kind='document' then item.id end,
        case when item.kind='workflow' then jsonb_build_object('workflow_id',item.id) else null end);
    select * into shown from organization_audit_events(org,owner_id,'') where id=event_id;
    perform pg_temp.assert_true(shown.title='Private item','owner can discover private item from its event');
    perform pg_temp.assert_true(shown.detail->'private_content_access'=jsonb_build_object('kind',item.kind,'item_id',item.id,'has_access',false),'descriptor identifies current private item for all five kinds');
    perform pg_temp.assert_true(org_private_access_role(org,item.kind,item.id,owner_id::text) is null,'viewing event grants no content access');
    select * into shown from organization_audit_events(org,admin_id,'') where id=event_id;
    perform pg_temp.assert_true(shown.title is null and shown.detail is null,'unprivileged admin receives redacted metadata');
    perform open_org_private_content(org,owner_id,item.kind,item.id);
    select * into shown from organization_audit_events(org,owner_id,'') where id=event_id;
    perform pg_temp.assert_true(shown.detail->'private_content_access'->>'has_access'='true','event records explicit read-only opening');
    perform pg_temp.assert_true(org_private_access_role(org,item.kind,item.id,owner_id::text)='viewer','opening from event only grants viewer');
    perform pg_temp.assert_true(exists(select 1 from organization_audit_events(org,owner_id,'') where action='org.private_content.opened' and detail->'private_content_access'->>'item_id'=item.id::text),'access audit event can reopen the same item');
    perform close_org_private_content(org,owner_id,item.kind,item.id);
  end loop;
  perform pg_temp.assert_true(not exists(select 1 from organization_audit_events(org,member_id,'')),'members cannot read organization audit');

  -- Parent access is resolved from current content, not stale event metadata.
  for item in select * from (values('document',child_doc),('chat',child_chat),('tabular_review',child_review)) as items(kind,id) loop
    event_id:=gen_random_uuid();
    insert into audit_events(id,org_id,user_id,action,title,document_id,chat_id,review_id)
      values(event_id,org,member_id,'fixture.child','Child',
        case when item.kind='document' then item.id end,
        case when item.kind='chat' then item.id end,
        case when item.kind='tabular_review' then item.id end);
    select * into shown from organization_audit_events(org,owner_id,'') where id=event_id;
    perform pg_temp.assert_true(shown.detail->'private_content_access'->>'kind'='project' and shown.detail->'private_content_access'->>'item_id'=project::text,'child event opens its private project');
  end loop;
  update documents set project_id=null,workflow_id=workflow where id=child_doc;
  select * into shown from organization_audit_events(org,owner_id,'') where document_id=child_doc;
  perform pg_temp.assert_true(shown.detail->'private_content_access'->>'item_id'=workflow::text,'document resolves current workflow parent');

  -- Do not manufacture access from archived, moved, personal, or forged IDs.
  update documents set archived_at=now() where id=doc;
  select * into shown from organization_audit_events(org,owner_id,'') where document_id=doc;
  perform pg_temp.assert_true(shown.document_id is null and shown.detail is null,'archived item has no private opening');
  update documents set archived_at=null,org_id=other_org where id=doc;
  select * into shown from organization_audit_events(org,owner_id,'') where document_id=doc;
  perform pg_temp.assert_true(shown.id is null,'moved organization document is redacted');
  update documents set org_id=personal_org where id=doc;
  perform pg_temp.assert_true(not exists(select 1 from organization_audit_events(org,owner_id,'') where detail->'private_content_access'->>'item_id'=doc::text),'personal content has no private opening');
  insert into audit_events(org_id,user_id,action,title,detail) values(org,owner_id,'fixture.forged','Own event',jsonb_build_object('private_content_access',jsonb_build_object('kind','document','item_id',doc,'has_access',true),'workflow_id','not-a-uuid'));
  select * into shown from organization_audit_events(org,owner_id,'') where action='fixture.forged';
  perform pg_temp.assert_true(not (shown.detail ? 'private_content_access'),'stored metadata cannot forge an access descriptor');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','organization_audit_events(uuid,uuid,text)','EXECUTE'),'browser cannot impersonate audit actor');
end; $$;
rollback;
