-- Migration date: 2026-10-30
-- Select the project page before hydrating filename matches. A match test
-- needs only existence; it must not transfer every matching document from
-- every reachable project merely to discard all but one page in JavaScript.
create or replace function public.search_project_directory(
  p_user_id text,p_user_email text,p_search_term text,p_limit integer,p_offset integer,p_workspace text default null
) returns jsonb language sql stable set search_path=public,pg_temp as $$
  with search as materialized (
    select lower(coalesce(p_search_term,'')) term,
      '%'||replace(replace(replace(coalesce(p_search_term,''),'\','\\'),'%','\%'),'_','\_')||'%' pattern
  ), reachable as materialized (
    select p.* from public.project_list_access(p_user_id,p_user_email,p_workspace) access
    join public.projects p on p.id=access.project_id
  ), page as materialized (
    select p.* from reachable p cross join search s
    where strpos(lower(coalesce(p.name,'')),s.term)>0 or strpos(lower(coalesce(p.cm_number,'')),s.term)>0
      or exists(select 1 from public.documents d join public.document_versions v on v.id=d.current_version_id and v.deleted_at is null
        where d.project_id=p.id and v.filename ilike s.pattern escape '\')
    order by p.updated_at desc nulls last,p.id
    limit greatest(coalesce(p_limit,20),1)+1 offset greatest(coalesce(p_offset,0),0)
  ), page_documents as materialized (
    select d.* from page p cross join search s
    cross join lateral (
      select item.* from public.documents item
      join public.document_versions v on v.id=item.current_version_id and v.deleted_at is null
      where item.project_id=p.id and v.filename ilike s.pattern escape '\'
      offset 0
    ) d
  ), grouped_documents as (
    select d.project_id,jsonb_agg(to_jsonb(d) order by d.id) documents from page_documents d group by d.project_id
  )
  select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object(
    'is_owner',coalesce(p.user_id::text=p_user_id,false),'documents',coalesce(d.documents,'[]'::jsonb),'folders','[]'::jsonb
  ) order by p.updated_at desc nulls last,p.id),'[]'::jsonb)
  from page p left join grouped_documents d on d.project_id=p.id;
$$;
revoke all on function public.search_project_directory(text,text,text,integer,integer,text) from public,anon,authenticated;
grant execute on function public.search_project_directory(text,text,text,integer,integer,text) to service_role;
