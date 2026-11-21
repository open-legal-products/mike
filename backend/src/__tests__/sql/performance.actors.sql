-- H6: history grows, but the picker reads one latest row per distinct actor.
begin;
do $$
declare owner_id uuid:=gen_random_uuid(); member_id uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  body text; plan jsonb; fetched numeric;
begin
  insert into auth.users(id,email) values(owner_id,owner_id||'@example.test'),(member_id,member_id||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Actor scaling',owner_id);
  insert into public.org_members(org_id,user_id,role) values(org,owner_id,'owner'),(org,member_id,'member');
  insert into public.audit_events(org_id,user_id,user_email,action,created_at)
    select org,case when n%2=0 then owner_id else member_id end,'recorded-'||n||'@example.test','org.updated',
      '2026-01-01'::timestamptz+n*interval '1 second' from generate_series(1,10000) n;
  analyze public.audit_events;
  assert (select count(*)=2 from public.organization_audit_actors(org,owner_id)), 'one identity per actor';
  assert (select count(*)=0 from public.organization_audit_actors(org,member_id)), 'members cannot use admin picker';
  assert (select count(*)=1 from public.organization_audit_actors(org,owner_id,'recorded-10000')), 'latest recorded email is searchable';
  assert (select count(*)=0 from public.organization_audit_actors(org,owner_id,'recorded-2@')), 'old recorded email is not the latest identity';
  select prosrc into body from pg_proc where oid='public.organization_audit_actors(uuid,uuid,text,integer,integer)'::regprocedure;
  body:=replace(replace(replace(replace(replace(body,'p_org_id',quote_literal(org)||'::uuid'),
    'p_actor_id',quote_literal(owner_id)||'::uuid'),'p_search',quote_literal('')),'p_offset','0'),'p_limit','21');
  execute 'explain (analyze,format json) '||body into plan;
  select coalesce(sum((v->>'Actual Rows')::numeric*(v->>'Actual Loops')::numeric),0) into fetched
    from jsonb_path_query(plan,'$.** ? (@."Relation Name" == "audit_events")') v;
  assert fetched<20, 'actor picker read historical events instead of seeking distinct actors';
end;
$$;
rollback;
