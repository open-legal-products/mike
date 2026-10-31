-- C5/H3/Q07: forward enumeration, legacy JSON parity, and platform-size isolation.
begin;
create or replace function pg_temp.original_item_document_ids(p_kind text, p_item_id uuid)
returns table(document_id uuid) language sql stable set search_path = public as $$
  select distinct d.id from public.documents d where
    (p_kind='project' and (d.project_id=p_item_id
      or exists(select 1 from public.chats c join public.chat_messages m on m.chat_id=c.id
        where c.project_id=p_item_id and m.files @> jsonb_build_array(jsonb_build_object('document_id',d.id::text)))
      or exists(select 1 from public.tabular_reviews r where r.project_id=p_item_id and (
        r.document_ids ? d.id::text
        or exists(select 1 from public.tabular_review_rows row where row.review_id=r.id and row.document_id=d.id)
        or exists(select 1 from public.tabular_review_rows row join public.tabular_review_row_sources source on source.row_id=row.id
          where row.review_id=r.id and source.document_id=d.id)))))
    or (p_kind='workflow' and d.workflow_id=p_item_id)
    or (p_kind='chat' and exists (
      select 1 from public.chat_messages m where m.chat_id=p_item_id
        and m.files @> jsonb_build_array(jsonb_build_object('document_id',d.id::text))))
    or (p_kind='tabular_review' and (
      exists (select 1 from public.tabular_reviews r where r.id=p_item_id and r.document_ids ? d.id::text)
      or exists (select 1 from public.tabular_review_rows r where r.review_id=p_item_id and r.document_id=d.id)
      or exists (select 1 from public.tabular_review_row_sources s join public.tabular_review_rows r on r.id=s.row_id
        where r.review_id=p_item_id and s.document_id=d.id)));
$$;
do $$
declare actor uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); review uuid:=gen_random_uuid();
  d1 uuid:=gen_random_uuid(); d2 uuid:=gen_random_uuid(); d3 uuid:=gen_random_uuid(); row_id uuid:=gen_random_uuid();
  item record; value jsonb; actual uuid[]; expected uuid[]; body text; plan jsonb; fetched numeric;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  insert into public.projects(id,user_id,name) values(project,actor,'Reference fixture');
  insert into public.chats(id,user_id,project_id,title) values(chat,actor,project,'Reference chat');
  insert into public.documents(id,user_id,project_id) values(d1,actor,project),(d2,actor,null),(d3,actor,null);
  insert into public.documents(id) select gen_random_uuid() from generate_series(1,10000);
  insert into public.chat_messages(chat_id,role,files) values(chat,'user',jsonb_build_array(
    jsonb_build_object('document_id',d2::text),jsonb_build_object('document_id',d2::text),
    jsonb_build_object('document_id','bad-id'),jsonb_build_object('document_id',upper(d3::text)),
    jsonb_build_object('document_id',gen_random_uuid()::text),jsonb_build_object('document_id',123)));
  insert into public.tabular_reviews(id,user_id,project_id,title,document_ids)
    values(review,actor,project,'Reference review',jsonb_build_array(d3::text,'bad-id'));
  insert into public.tabular_review_rows(id,review_id,label,row_type,document_id) values(row_id,review,'Row','document',d2);
  insert into public.tabular_review_row_sources(row_id,document_id) values(row_id,d3);
  for item in select * from (values('project',project),('chat',chat),('tabular_review',review),('unknown',project)) x(kind,id) loop
    select array_agg(document_id order by document_id) into actual from public.org_item_document_ids(item.kind,item.id);
    select array_agg(document_id order by document_id) into expected from pg_temp.original_item_document_ids(item.kind,item.id);
    assert actual is not distinct from expected,'forward references differ from original membership semantics';
  end loop;
  foreach value in array array[jsonb_build_object(d1::text,true),to_jsonb(d1::text),'null'::jsonb,'123'::jsonb] loop
    update public.tabular_reviews set document_ids=value where id=review;
    select array_agg(document_id order by document_id) into actual from public.org_item_document_ids('tabular_review',review);
    select array_agg(document_id order by document_id) into expected from pg_temp.original_item_document_ids('tabular_review',review);
    assert actual is not distinct from expected,'legacy JSON shape changed';
  end loop;
  analyze public.documents; analyze public.chat_messages;
  select prosrc into body from pg_proc where oid='public.org_item_document_ids(text,uuid)'::regprocedure;
  body:=replace(replace(body,'p_kind',quote_literal('chat')),'p_item_id',quote_literal(chat)||'::uuid');
  execute 'explain (analyze,format json) '||body into plan;
  select coalesce(sum((v->>'Actual Rows')::numeric*(v->>'Actual Loops')::numeric),0) into fetched
    from jsonb_path_query(plan,'$.** ? (@."Relation Name" == "documents")') v;
  assert fetched<20,'reference enumeration scanned unrelated platform documents';
end;
$$;
rollback;

-- Departure preview must enumerate each retained item once, independent of
-- how many standalone files the departing member owns.
begin;
create temporary sequence reference_calls minvalue 0 start 0;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid();
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Departure references',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member');
  insert into public.documents(id,org_id,user_id) values(doc,org,member_id);
  insert into public.documents(org_id,user_id) select org,member_id from generate_series(1,39);
  insert into public.chats(org_id,user_id,title) select org,owner_id,'Retained '||n from generate_series(1,10) n;
  insert into public.chat_messages(chat_id,role,files) select id,'user',jsonb_build_array(jsonb_build_object('document_id',doc::text))
    from public.chats where org_id=org;
  perform set_config('mike.test_ref_org',org::text,true);
  perform set_config('mike.test_ref_member',member_id::text,true);
end;
$$;
alter function public.org_item_document_ids(text,uuid) rename to audit_reference_implementation;
create function public.org_item_document_ids(p_kind text,p_item_id uuid)
returns table(document_id uuid) language plpgsql set search_path=public as $$
begin
  perform nextval('pg_temp.reference_calls');
  return query select * from public.audit_reference_implementation(p_kind,p_item_id);
end;
$$;
do $$
declare transfers integer; archives integer; calls integer;
begin
  select count(*) filter(where disposition='transfer'),count(*) filter(where disposition='archive') into transfers,archives
    from public.org_members_departure_items(current_setting('mike.test_ref_org')::uuid,array[current_setting('mike.test_ref_member')::uuid]);
  select last_value+1 into calls from pg_temp.reference_calls;
  assert transfers=1 and archives=39,'retained reference classification';
  assert calls=10,'departure enumerated retained items repeatedly per owned document';
end;
$$;
rollback;
