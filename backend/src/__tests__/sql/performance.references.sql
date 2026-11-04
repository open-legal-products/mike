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

-- C5/S4: departure classification starts from the departing member's
-- documents and looks up their references; it never expands every retained
-- chat or review in the organization. Every reference shape and every
-- retained/not-retained container, for chats and reviews alike, gets the
-- disposition the pre-rewrite function (a verbatim oracle) gives it.
begin;
\ir oracles/departure-items.sql
create temporary table departure_expected(label text,id uuid,disposition text);
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid();
  live_project uuid:=gen_random_uuid(); archived_project uuid:=gen_random_uuid(); member_project uuid:=gen_random_uuid();
  retained_chat uuid:=gen_random_uuid(); archived_chat uuid:=gen_random_uuid(); member_chat uuid:=gen_random_uuid();
  project_chat uuid:=gen_random_uuid(); archived_project_chat uuid:=gen_random_uuid(); member_project_chat uuid:=gen_random_uuid(); other_chat uuid:=gen_random_uuid();
  review uuid:=gen_random_uuid(); key_review uuid:=gen_random_uuid(); scalar_review uuid:=gen_random_uuid(); row_id uuid:=gen_random_uuid();
  archived_review uuid:=gen_random_uuid(); member_review uuid:=gen_random_uuid(); archived_project_review uuid:=gen_random_uuid();
  member_project_review uuid:=gen_random_uuid(); other_review uuid:=gen_random_uuid();
  fixture_label text; doc uuid;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Departure references',owner_id),(other_org,'Elsewhere',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member'),(other_org,owner_id,'owner');
  foreach fixture_label in array array['chat','chat-upper','review-array','review-key','review-scalar','row','source','archived-chat',
    'member-chat','project-chat','archived-project-chat','member-project-chat','other-org-chat','unreferenced',
    'archived-review','member-review','archived-project-review','member-project-review','other-org-review'] loop
    insert into public.documents(org_id,user_id) values(org,member_id) returning id into doc;
    insert into departure_expected values(fixture_label,doc,case when fixture_label in ('chat','review-array','review-key','review-scalar','row','source','project-chat') then 'transfer' else 'archive' end);
  end loop;
  insert into public.documents(org_id,user_id) select org,member_id from generate_series(1,30);
  insert into public.projects(id,org_id,user_id,name,visibility) values(live_project,org,owner_id,'Live','organization'),
    (archived_project,org,owner_id,'Archived','organization'),(member_project,org,member_id,'Departing private','private');
  update public.projects set archived_at=now() where id=archived_project;
  insert into public.chats(id,org_id,user_id,project_id,title) values(retained_chat,org,owner_id,null,'Retained'),
    (archived_chat,org,owner_id,null,'Archived'),(member_chat,org,member_id,null,'Departing'),(project_chat,org,owner_id,live_project,'Project'),
    (archived_project_chat,org,owner_id,archived_project,'Archived project'),(member_project_chat,org,owner_id,member_project,'Departing project'),
    (other_chat,other_org,owner_id,null,'Other org');
  update public.chats set archived_at=now() where id=archived_chat;
  insert into public.chats(org_id,user_id,title) select org,owner_id,'Unrelated '||n from generate_series(1,200) n;
  insert into public.chat_messages(chat_id,role,files) select c.id,'user',jsonb_build_array(jsonb_build_object('document_id',
      case e.label when 'chat-upper' then upper(e.id::text) else e.id::text end),jsonb_build_object('document_id',123))
    from departure_expected e join (values('chat',retained_chat),('chat-upper',retained_chat),('archived-chat',archived_chat),('member-chat',member_chat),
      ('project-chat',project_chat),('archived-project-chat',archived_project_chat),('member-project-chat',member_project_chat),('other-org-chat',other_chat)) c(label,id)
      on c.label=e.label;
  insert into public.chat_messages(chat_id,role,files) select id,'user','[{"document_id":"unrelated"}]' from public.chats where title like 'Unrelated %';
  insert into public.tabular_reviews(id,org_id,user_id,title,document_ids) values
    (review,org,owner_id,'Array',jsonb_build_array((select id from departure_expected where label='review-array')::text,'bad-id')),
    (key_review,org,owner_id,'Key',jsonb_build_object((select id from departure_expected where label='review-key')::text,true)),
    (scalar_review,org,owner_id,'Scalar',to_jsonb((select id from departure_expected where label='review-scalar')::text));
  insert into public.tabular_review_rows(id,review_id,label,row_type,document_id) values(row_id,review,'Row','document',(select id from departure_expected where label='row'));
  insert into public.tabular_review_row_sources(row_id,document_id) values(row_id,(select id from departure_expected where label='source'));
  -- Review containers that are not retained: archived, the departing
  -- member's own, in an archived project, in the departing member's private
  -- project, and in another organization.
  insert into public.tabular_reviews(id,org_id,user_id,project_id,title,document_ids)
    select r.id,r.org_id,r.user_id,r.project_id,'Not retained',jsonb_build_array(e.id::text)
    from departure_expected e join (values('archived-review',archived_review,org,owner_id,null::uuid),('member-review',member_review,org,member_id,null),
      ('archived-project-review',archived_project_review,org,owner_id,archived_project),('member-project-review',member_project_review,org,owner_id,member_project),
      ('other-org-review',other_review,other_org,owner_id,null)) r(label,id,org_id,user_id,project_id) on r.label=e.label;
  update public.tabular_reviews set archived_at=now() where id=archived_review;
  perform set_config('mike.test_ref_org',org::text,true);
  perform set_config('mike.test_ref_member',member_id::text,true);
end;
$$;
create temporary table departure_oracle as
  select item_id,disposition from pg_temp.departure_items_oracle(current_setting('mike.test_ref_org')::uuid,array[current_setting('mike.test_ref_member')::uuid])
  where kind='document';
create or replace function public.org_item_document_ids(p_kind text,p_item_id uuid)
returns table(document_id uuid) language plpgsql stable set search_path=public as $$
begin raise exception 'Departure classification expanded every retained item''s references'; end;
$$;
do $$
declare actual jsonb; expected jsonb;
begin
  select jsonb_object_agg(item_id,disposition) into actual
    from public.org_members_departure_items(current_setting('mike.test_ref_org')::uuid,array[current_setting('mike.test_ref_member')::uuid])
    where kind='document';
  select jsonb_object_agg(item_id,disposition) into expected from departure_oracle;
  assert (select bool_and(o.disposition=e.disposition) from departure_expected e join departure_oracle o on o.item_id=e.id),
    'fixture labels disagree with the original function';
  assert actual=expected,format('departure dispositions changed: %s',
    (select jsonb_object_agg(e.label,actual->>e.id::text) from departure_expected e where actual->>e.id::text is distinct from expected->>e.id::text));
end;
$$;
rollback;

-- S4/S5: the reverse lookup returns exactly the items whose forward
-- reference list contains the document, for every fixture shape above.
begin;
do $$
declare actor uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); chat uuid:=gen_random_uuid(); review uuid:=gen_random_uuid();
  d1 uuid:=gen_random_uuid(); d2 uuid:=gen_random_uuid(); d3 uuid:=gen_random_uuid(); row_id uuid:=gen_random_uuid();
  doc uuid; value jsonb; actual jsonb; expected jsonb;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test');
  insert into public.projects(id,user_id,name) values(project,actor,'Reference fixture');
  insert into public.chats(id,user_id,project_id,title) values(chat,actor,project,'Reference chat');
  insert into public.documents(id,user_id,project_id) values(d1,actor,project),(d2,actor,null),(d3,actor,null);
  insert into public.chat_messages(chat_id,role,files) values(chat,'user',jsonb_build_array(
    jsonb_build_object('document_id',d2::text),jsonb_build_object('document_id',jsonb_build_array(d1::text)),
    jsonb_build_object('document_id',upper(d3::text)),jsonb_build_object('document_id',123)));
  insert into public.tabular_reviews(id,user_id,project_id,title,document_ids) values(review,actor,null,'Reference review',jsonb_build_array(d3::text,'bad-id'));
  insert into public.tabular_review_rows(id,review_id,label,row_type,document_id) values(row_id,review,'Row','document',d2);
  insert into public.tabular_review_row_sources(row_id,document_id) values(row_id,d1);
  foreach value in array array[jsonb_build_array(d3::text),jsonb_build_object(d1::text,true),to_jsonb(d2::text),'null'::jsonb,jsonb_build_array(jsonb_build_array(d3::text))] loop
    update public.tabular_reviews set document_ids=value where id=review;
    foreach doc in array array[d1,d2,d3] loop
      select coalesce(jsonb_agg(jsonb_build_array(kind,item_id,project_id) order by kind,item_id),'[]') into actual
        from public.document_referencing_items(doc);
      select coalesce(jsonb_agg(jsonb_build_array(i.kind,i.id,i.project_id) order by i.kind,i.id),'[]') into expected
        from (select 'chat' kind,c.id,c.project_id from public.chats c union all select 'tabular_review',r.id,r.project_id from public.tabular_reviews r) i
        where exists(select 1 from public.org_item_document_ids(i.kind,i.id) f where f.document_id=doc);
      assert actual=expected,format('reverse references for %s with %s: %s, forward: %s',doc,value,actual,expected);
    end loop;
  end loop;
end;
$$;
rollback;

-- Each reverse lookup is an index condition under the generic plan the
-- non-inlined helper runs with, so its cost follows the document's own
-- references rather than the platform's chats and reviews.
begin;
set local enable_seqscan=off;
set local plan_cache_mode=force_generic_plan;
do $$
declare probe text; plan jsonb;
begin
  foreach probe in array array[
    'select 1 from public.chat_messages m where m.files @> jsonb_build_array(jsonb_build_object(''document_id'',$1::text))',
    'select 1 from public.tabular_reviews r where r.document_ids ? $1::text',
    'select 1 from public.tabular_review_rows row where row.document_id=$1',
    'select 1 from public.tabular_review_row_sources source where source.document_id=$1'] loop
    execute 'prepare reverse_probe(uuid) as '||probe;
    execute 'explain (format json) execute reverse_probe(gen_random_uuid())' into plan;
    deallocate reverse_probe;
    assert jsonb_path_exists(plan,'$.**."Index Cond"'),format('reverse reference lookup is not indexed: %s',probe);
  end loop;
end;
$$;
rollback;
