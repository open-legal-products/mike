-- H9: participation must precede every filter, count and page.
begin;
create or replace function pg_temp.projects_before_participation(
  p_user_id text,
  p_user_email text,
  p_scope text,
  p_limit integer,
  p_offset integer,
  p_search_term text,
  p_sort_key text,
  p_sort_direction text,
  p_practice text,
  p_owner_user_id text,
  p_workspace text default null
)
returns table (
  id uuid,
  user_id text,
  org_id uuid,
  access_scope text,
  organization_name text,
  name text,
  cm_number text,
  practice text,
  created_at timestamptz,
  updated_at timestamptz,
  is_owner boolean,
  owner_display_name text,
  owner_email text,
  access_role text,
  document_count integer,
  chat_count integer,
  review_count integer
)
language sql
stable
set search_path=public,pg_temp
as $$
  with visible_projects as (
    select p.*, access.role as list_access_role
    from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
    where true
      and public.workspace_matches(p_workspace, p.org_id)
      and (
        coalesce(p_scope, 'all') = 'all'
        or (p_scope = 'mine' and p.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end))
        or (p_scope = 'shared' and (p.user_id is null or p.user_id::text <> p_user_id))
        or (
          p_scope = 'collaborative'
          and (
            p.user_id is null
            or p.user_id::text <> p_user_id
            or public.project_access_scope(p.id, p.org_id, p.visibility) <> 'private'
          )
        )
        or (
          p_scope = 'private'
          and p.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
          and public.project_access_scope(p.id, p.org_id, p.visibility) = 'private'
        )
        -- The Public and Private tabs: public is open to the whole
        -- organization; everything else, shared with individuals or not, is
        -- private.
        or (
          p_scope = 'public'
          and public.project_access_scope(p.id, p.org_id, p.visibility) = 'organization'
        )
        or (
          p_scope = 'nonpublic'
          and public.project_access_scope(p.id, p.org_id, p.visibility) <> 'organization'
        )
      )
      and (
        p_search_term is null
        or p_search_term = ''
        or lower(coalesce(p.name, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.cm_number, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
        or lower(coalesce(p.practice, '')) like
          '%' || replace(replace(replace(lower(p_search_term), '\', '\\'), '%', '\%'), '_', '\_') || '%'
          escape '\'
      )
      and (p_practice is null or p.practice = p_practice)
      and (p_owner_user_id is null or p.user_id = (case when p_owner_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_owner_user_id::uuid end))
  ),
  document_counts as (
    select d.project_id, count(*)::integer as document_count
    from public.documents d
    where d.project_id in (select vp.id from visible_projects vp)
    group by d.project_id
  ),
  chat_counts as (
    select c.project_id, count(*)::integer as chat_count
    from public.chats c
    where c.project_id in (select vp.id from visible_projects vp)
    group by c.project_id
  ),
  review_counts as (
    select tr.project_id, count(*)::integer as review_count
    from public.tabular_reviews tr
    where tr.project_id in (select vp.id from visible_projects vp)
    group by tr.project_id
  )
  select
    vp.id,
    vp.user_id::text as user_id,
    vp.org_id,
    public.project_access_scope(vp.id, vp.org_id, vp.visibility) as access_scope,
    (
      select nullif(trim(o.name), '')
      from public.organizations o
      where o.id = vp.org_id
    ) as organization_name,
    vp.name,
    vp.cm_number,
    vp.practice,
    vp.created_at,
    vp.updated_at,
    coalesce(vp.user_id = (case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end), false) as is_owner,
    nullif(trim(up.display_name), '') as owner_display_name,
    -- Populated at last. The column has always been declared and always
    -- returned NULL, so the UI's "ask the project admin" line had no address
    -- to render and silently collapsed to nothing.
    up.email as owner_email,
    vp.list_access_role as access_role,
    coalesce(dc.document_count, 0) as document_count,
    coalesce(cc.chat_count, 0) as chat_count,
    coalesce(rc.review_count, 0) as review_count
  from visible_projects vp
  left join public.user_profiles up
    on up.user_id = vp.user_id
  left join document_counts dc
    on dc.project_id = vp.id
  left join chat_counts cc
    on cc.project_id = vp.id
  left join review_counts rc
    on rc.project_id = vp.id
  order by
    case when p_sort_key = 'name' and p_sort_direction = 'asc' then lower(coalesce(vp.name, '')) else null end asc,
    case when p_sort_key = 'name' and p_sort_direction = 'desc' then lower(coalesce(vp.name, '')) else null end desc,
    case when p_sort_key = 'cm' and p_sort_direction = 'asc' then lower(coalesce(vp.cm_number, '')) else null end asc,
    case when p_sort_key = 'cm' and p_sort_direction = 'desc' then lower(coalesce(vp.cm_number, '')) else null end desc,
    case when p_sort_key = 'files' and p_sort_direction = 'asc' then coalesce(dc.document_count, 0) else null end asc,
    case when p_sort_key = 'files' and p_sort_direction = 'desc' then coalesce(dc.document_count, 0) else null end desc,
    case when p_sort_key = 'chats' and p_sort_direction = 'asc' then coalesce(cc.chat_count, 0) else null end asc,
    case when p_sort_key = 'chats' and p_sort_direction = 'desc' then coalesce(cc.chat_count, 0) else null end desc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'asc' then coalesce(rc.review_count, 0) else null end asc,
    case when p_sort_key = 'reviews' and p_sort_direction = 'desc' then coalesce(rc.review_count, 0) else null end desc,
    case when p_sort_key = 'created' and p_sort_direction = 'asc' then vp.created_at else null end asc,
    case when p_sort_key = 'created' and p_sort_direction = 'desc' then vp.created_at else null end desc,
    case when p_sort_key = 'updated' and p_sort_direction = 'asc' then vp.updated_at else null end asc,
    case when p_sort_key = 'updated' and p_sort_direction = 'desc' then vp.updated_at else null end desc,
    vp.created_at desc,
    vp.id asc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create temporary table participation_bulk(n integer primary key,id uuid);
do $$
declare actor uuid:=gen_random_uuid(); peer uuid:=gen_random_uuid(); org uuid:=gen_random_uuid();
  own_item uuid:=gen_random_uuid(); personal_share uuid:=gen_random_uuid(); org_public uuid:=gen_random_uuid(); org_private uuid:=gen_random_uuid(); opened uuid:=gen_random_uuid();
  actual uuid[]; expected uuid[]; before_rows jsonb; after_rows jsonb; f record; doc record; result_count integer;
begin
  insert into auth.users(id,email) values(actor,actor||'@example.test'),(peer,peer||'@example.test');
  insert into public.organizations(id,name,created_by) values(org,'Participation regression',peer);
  insert into public.org_members(org_id,user_id,role) values(org,actor,'admin'),(org,peer,'owner');
  insert into public.projects(user_id,org_id,name,visibility,practice)
    select peer,org,'A inherited '||lpad(i::text,4,'0'),'organization','Inherited' from generate_series(1,1100) i;
  insert into participation_bulk select i,gen_random_uuid() from generate_series(1,1105) i;
  insert into public.projects(id,user_id,name,practice)
    select id,actor,'Q bulk '||lpad(n::text,4,'0'),'Bulk' from participation_bulk;
  insert into public.projects(id,user_id,org_id,name,visibility,practice,cm_number) values
    (own_item,actor,null,'Z target created','private','TargetA',null),
    (personal_share,peer,null,'Z target personal','private','TargetB',null),
    (org_public,peer,org,'Z target organization','organization','TargetA',null),
    (org_private,peer,org,'Z target secondary','private','TargetA','CM-needle'),
    (opened,peer,org,'Z target opened only','private','TargetA',null);
  insert into public.project_access_grants(project_id,email,role,created_by) values(personal_share,actor||'@example.test','viewer',peer);
  insert into public.project_org_access_overrides(project_id,org_id,user_id,role) values(org_public,org,actor,'viewer'),(org_private,org,actor,'viewer');
  perform public.set_org_private_content_permission(org,peer,actor,true);
  perform public.open_org_private_content(org,actor,'project',opened);
  -- Document counts remain part of the same filtered/sorted query.
  insert into public.documents(user_id,project_id) values(actor,own_item),(peer,personal_share),(peer,personal_share),(peer,personal_share),(peer,org_public),(peer,org_public);

  select array_agg(id) into actual from public.get_projects_overview(actor::text,upper(actor||'@example.test'),'all',2,0,null,'name','asc',null,null,null,true);
  select array_agg(id order by n) into expected from participation_bulk where n<=2;
  assert actual=expected,'participation precedes pagination: 1100 inherited public rows cannot consume the first page';
  select count(*) into result_count from public.get_projects_overview(actor::text,actor||'@example.test','all',3000,0,null,'name','asc',null,null,null,true);
  assert result_count=1109,'the participating candidate set is not capped at a gateway-sized 1000 rows';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','all',4,1104,null,'name','asc',null,null,null,true);
  select array[id,own_item,org_public,personal_share] into expected from participation_bulk where n=1105;
  assert actual=expected,'pagination beyond 1000 participating candidates remains complete and ordered';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,upper(actor||'@example.test'),'all',10,0,'Z target','name','asc',null,null,null,true);
  assert actual=array[own_item,org_public,personal_share,org_private],'created/direct/org participants preserve search and sorting; private openings alone are not participation';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','public',10,0,'Z target','name','asc',null,null,null,true);
  assert actual=array[org_public],'public scope still applies';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','mine',10,0,'Z target','name','asc',null,null,null,true);
  assert actual=array[own_item],'mine scope still applies';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','all',10,0,'needle','name','asc',null,null,null,true);
  assert actual=array[org_private],'search still matches the case number';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','all',10,0,'Z target','name','desc','TargetA',null,null,true);
  assert actual=array[org_private,org_public,own_item],'practice and descending sort remain effective';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','all',10,0,'Z target','name','asc',null,peer::text,null,true);
  assert actual=array[org_public,personal_share,org_private],'owner filter remains effective';
  select array_agg(id) into actual from public.get_projects_overview(actor::text,actor||'@example.test','all',10,0,'Z target','name','asc',null,null,'personal',true);
  assert actual=array[own_item,personal_share],'personal workspace excludes organizational participation';
  select * into doc from public.get_projects_overview(actor::text,actor||'@example.test','all',1,0,'Z target','files','desc',null,null,null,true);
  assert doc.id=personal_share and doc.document_count=3,'document counts and file sorting remain correct';

  -- The omitted flag and explicit false must preserve every old return field,
  -- including count/provenance/role columns, against the previous SQL body.
  for f in select * from (values
    ('all',null::text,'name','asc',null::text,null::text,null::text),
    ('public','Z target','updated','desc',null,null,org::text),
    ('all','Z target','files','desc','TargetA',null,null),
    ('shared','Z target','name','desc',null,peer::text,null)
  ) v(scope,search,sort,direction,practice,owner,workspace) loop
    select jsonb_agg(to_jsonb(p)) into before_rows from pg_temp.projects_before_participation(actor::text,actor||'@example.test',f.scope,25,0,f.search,f.sort,f.direction,f.practice,f.owner,f.workspace) p;
    select jsonb_agg(to_jsonb(p)) into after_rows from public.get_projects_overview(actor::text,actor||'@example.test',f.scope,25,0,f.search,f.sort,f.direction,f.practice,f.owner,f.workspace) p;
    assert after_rows is not distinct from before_rows,'old 11-position call preserves the complete prior response with flag omitted';
    select jsonb_agg(to_jsonb(p)) into after_rows from public.get_projects_overview(actor::text,actor||'@example.test',f.scope,25,0,f.search,f.sort,f.direction,f.practice,f.owner,f.workspace,false) p;
    assert after_rows is not distinct from before_rows,'explicit false preserves prior behavior';
  end loop;
  select jsonb_agg(to_jsonb(p)) into before_rows from pg_temp.projects_before_participation(actor::text,actor||'@example.test','all',25,0,null,'name','asc',null,null) p;
  select jsonb_agg(to_jsonb(p)) into after_rows from public.get_projects_overview(actor::text,actor||'@example.test','all',25,0,null,'name','asc',null,null) p;
  assert after_rows is not distinct from before_rows,'old 10-position call resolves both defaults';
  assert to_regprocedure('public.get_projects_overview(text,text,text,integer,integer,text,text,text,text,text,text)') is null,'old overload removed without ambiguity';
  assert to_regprocedure('public.get_projects_overview(text,text)') is not null,'legacy two-argument overload retained';
  assert not has_function_privilege('authenticated','public.get_projects_overview(text,text,text,integer,integer,text,text,text,text,text,text,boolean)','EXECUTE'),'new actor-taking overload is server-only';
  assert has_function_privilege('service_role','public.get_projects_overview(text,text,text,integer,integer,text,text,text,text,text,text,boolean)','EXECUTE'),'backend service keeps execute permission';
end;
$$;
rollback;
