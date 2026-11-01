-- S2: an access verdict finds the caller's membership with one unique-index
-- probe. Casting org_members.user_id to text hid the column from the
-- (org_id,user_id) index, so each verdict read every member of the org.
begin;
-- Rows a statement read from a table and its indexes in this transaction.
create function pg_temp.rel_work(rel regclass) returns bigint language sql as $$
  select sum(pg_stat_get_xact_tuples_returned(c.oid)+pg_stat_get_xact_tuples_fetched(c.oid))::bigint
  from pg_class c where c.oid=rel or c.oid in (select indexrelid from pg_index where indrelid=rel);
$$;
do $$
declare actor uuid:=gen_random_uuid(); author uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  project uuid:=gen_random_uuid(); workflow uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid();
  before bigint; probe record; verdict text;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test'),(author,author||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Large membership',author);
  insert into public.org_members(org_id,user_id,role) values(org,author,'owner'),(org,actor,'member');
  insert into auth.users(id,email) select gen_random_uuid(),'member-'||n||'@example.test' from generate_series(1,1000) n;
  insert into public.org_members(org_id,user_id,role)
    select org,id,'member' from auth.users where email like 'member-%@example.test';
  insert into public.projects(id,org_id,user_id,name,visibility) values(project,org,author,'Public','organization');
  insert into public.workflows(id,org_id,user_id,title,type,visibility) values(workflow,org,author,'Public','assistant','organization');
  insert into public.chats(id,org_id,user_id,title) values(chat,org,actor,'Own team chat');
  insert into public.documents(id,org_id,user_id) values(doc,org,actor);
  analyze public.org_members;
  for probe in select * from (values
    ('project','editor'),('workflow','editor'),('chat','owner'),('document','true')) x(kind,expected) loop
    before:=pg_temp.rel_work('public.org_members');
    verdict:=case probe.kind
      when 'project' then public.project_access_role(project,author,org,actor::text,'')
      when 'workflow' then public.workflow_access_role(workflow,author,org,actor::text,'')
      when 'chat' then public.chat_access_role(chat,actor,null,org,actor::text,'')
      else public.document_text_access(doc,actor::text,'')::text end;
    assert verdict=probe.expected,format('%s verdict changed: %s',probe.kind,verdict);
    assert pg_temp.rel_work('public.org_members')-before<=5,
      format('%s verdict read %s membership rows; one indexed probe expected',probe.kind,pg_temp.rel_work('public.org_members')-before);
    -- Only the canonical lowercase text of the uuid ever matched a member.
    verdict:=case probe.kind
      when 'project' then public.project_access_role(project,author,org,upper(actor::text),'')
      when 'workflow' then public.workflow_access_role(workflow,author,org,upper(actor::text),'')
      when 'chat' then public.chat_access_role(chat,actor,null,org,replace(actor::text,'-',''),'')
      else public.document_text_access(doc,upper(actor::text),'')::text end;
    assert verdict is null or verdict='false',format('%s accepted a non-canonical actor id',probe.kind);
  end loop;
end;
$$;
rollback;
