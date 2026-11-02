-- Rollback-only checks of RPC pagination, visibility and bounded redaction.
begin;
create function pg_temp.assert_true(value boolean, message text) returns void language plpgsql as $$
begin if value is distinct from true then raise exception '%',message; end if; end; $$;
do $$
declare
  owner_id uuid:=gen_random_uuid(); admin_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid();
  org uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); hidden_id uuid:=gen_random_uuid();
  result jsonb; expected jsonb; chosen uuid[]; sorting text; direction text;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(admin_id,admin_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into organizations(id,name,created_by,kind) values(org,'Pagination fixture',owner_id,'team');
  insert into org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,admin_id,'admin'),(org,member_id,'member');
  insert into projects(id,org_id,user_id,name) values(project,org,member_id,'Secret project');
  insert into audit_events(org_id,user_id,user_email,action,title,model,status,surface,created_at)
    select org,owner_id,'owner@example.test',case when i%2=0 then 'org.updated' else 'org.created' end,
      'Title '||lpad(i::text,2,'0'),case when i%3=0 then null else 'Model '||i end,
      case when i%2=0 then 'success' else 'error' end,'web', '2026-10-01'::timestamptz+i*interval '1 day'
    from generate_series(1,20) i;
  insert into audit_events(id,org_id,user_id,action,title,project_id,created_at)
    values(hidden_id,org,member_id,'project.updated','Hidden title',project,'2026-09-01');
  foreach sorting in array array['created_at','user_email','model','title'] loop
    foreach direction in array array['asc','desc'] loop
      execute format('select coalesce(jsonb_agg(to_jsonb(e)),''[]''::jsonb) from
        (select * from public.organization_audit_events($1,$2,$3) order by %I %s nulls last,id asc limit 3 offset 4) e',sorting,direction)
        into expected using org,admin_id,'';
      result:=organization_audit_events_page(org,admin_id,'','{}',sorting,direction,4,3);
      perform pg_temp.assert_true(result->'events'=expected and (result->>'total')::int=21,'page and exact count match the redacted feed for every supported sort');
    end loop;
  end loop;
  result:=organization_audit_events_page(org,admin_id,'',jsonb_build_object('title_pattern','%Hidden%'));
  perform pg_temp.assert_true(result=jsonb_build_object('events','[]'::jsonb,'total',0),'search cannot infer a redacted private title');
  result:=organization_audit_events_page(org,owner_id,'',jsonb_build_object('title_pattern','%Hidden%'));
  perform pg_temp.assert_true(result->>'total'='1' and result->'events'->0->>'id'=hidden_id::text,'authorized owner can search private titles');
  update user_profiles set display_name='A%_ Lawyer' where user_id=owner_id;
  result:=organization_audit_events_page(org,admin_id,'',jsonb_build_object('username_pattern','%A\%\_%'));
  perform pg_temp.assert_true(result->>'total'='20','literal username search is scoped to this organization actors');
  result:=organization_audit_events_page(org,admin_id,'',jsonb_build_object('username_pattern','%owner@example.test%'));
  perform pg_temp.assert_true(result->>'total'='20','recorded actor emails remain searchable');
  result:=organization_audit_events_page(org,admin_id,'',jsonb_build_object('username_pattern','%Nobody%'));
  perform pg_temp.assert_true(result->>'total'='0','no matching actor gives an empty result');
  select array_agg(id) into chosen from audit_events where org_id=org and action='org.updated';
  result:=organization_audit_events_page(org,admin_id,'',jsonb_build_object(
    'action','org.updated','status','success','surface','web','actor_user_id',owner_id,
    'event_ids',chosen,'user_ids',array[owner_id],'from','2026-10-05','to','2026-10-13T23:59:59.999Z'),
    'created_at','asc',1,2);
  perform pg_temp.assert_true(result->>'total'='5' and jsonb_array_length(result->'events')=2
    and result->'events'->0->>'title'='Title 06' and result->'events'->1->>'title'='Title 08','all filters apply before count and page');
  result:=organization_audit_events_page(org,admin_id,'','{"event_ids":[]}');
  perform pg_temp.assert_true(result->>'total'='0' and result->'events'='[]'::jsonb,'empty selection cannot widen to all events');
  result:=organization_audit_events_page(org,admin_id,'','{}','created_at','desc',100,2);
  perform pg_temp.assert_true(result->>'total'='21' and result->'events'='[]'::jsonb,'empty page preserves the total');
  result:=organization_audit_events_page(org,member_id,'');
  perform pg_temp.assert_true(result=jsonb_build_object('events','[]'::jsonb,'total',0),'ordinary members cannot read or count organization events');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','organization_audit_events_page(uuid,uuid,text,jsonb,text,text,integer,integer)','EXECUTE'),'browser cannot impersonate an audit actor');
  perform pg_temp.assert_true(not has_function_privilege('authenticated','organization_audit_events(uuid,uuid,text,uuid[])','EXECUTE'),'selected-row helper remains service-only');
  perform set_config('mike.test_audit_org',org::text,true);
  perform set_config('mike.test_audit_actor',admin_id::text,true);
end; $$;

-- Fail if a regular page resolves access for more events than it returns.
-- Keep the real redaction implementation behind the instrumentation wrapper.
alter function public.organization_audit_events(uuid,uuid,text,uuid[]) rename to test_audit_redaction;
create function public.organization_audit_events(p_org_id uuid,p_actor_id uuid,p_actor_email text,p_event_ids uuid[])
returns setof public.audit_events language plpgsql stable set search_path=public,pg_temp as $$
begin
  if p_event_ids is null or cardinality(p_event_ids)>2 then raise exception 'Redaction exceeded requested page'; end if;
  return query select * from public.test_audit_redaction(p_org_id,p_actor_id,p_actor_email,p_event_ids);
end; $$;
select pg_temp.assert_true(
  organization_audit_events_page(current_setting('mike.test_audit_org')::uuid,current_setting('mike.test_audit_actor')::uuid,'','{}','created_at','desc',10,2)->>'total'='21',
  'ordinary pagination counts all candidates but only resolves access for two events');
select pg_temp.assert_true(
  organization_audit_events_page(current_setting('mike.test_audit_org')::uuid,current_setting('mike.test_audit_actor')::uuid,'','{}','created_at','desc',100,2)->'events'='[]'::jsonb,
  'empty pages never fall back to resolving the whole organization');
rollback;
