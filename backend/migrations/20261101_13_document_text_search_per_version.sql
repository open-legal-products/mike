-- Migration date: 2026-11-01
-- find_document_text joined its eligible versions (one user's library,
-- project or document) to document_version_texts freely. plpgsql reuses a
-- generic plan after a few calls, and with the search text unknown that plan
-- scanned the trigram index (hits) and the whole text table (coverage)
-- across all tenants. Each eligible version is now one primary-key probe.
create or replace function public.find_document_text(
  p_user_id text,p_user_email text,p_workspace text,p_scope text,p_query text,
  p_project_id uuid default null,p_document_id uuid default null,p_version_id uuid default null,
  p_limit integer default 10,p_offset integer default 0
) returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare result jsonb; project_allowed boolean; page_limit integer:=least(greatest(coalesce(p_limit,10),1),20);
begin
  if p_scope is null or p_scope not in ('project','library','templates','document') or p_query is null
    or char_length(trim(p_query))<2 or char_length(p_query)>500
    or p_offset is null or p_offset<0 or p_offset>100000
    or (p_scope='project' and p_project_id is null)
    or (p_scope='document' and p_document_id is null)
    or (p_version_id is not null and p_scope<>'document') then
    raise exception 'Invalid document search' using errcode='22023';
  end if;
  if p_scope='project' then
    select public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) is not null
      into project_allowed from public.projects p where p.id=p_project_id;
  end if;
  with eligible as materialized (
    select d.id document_id,d.library_kind,v.id version_id,v.version_number,v.filename,v.file_type,
      v.storage_path,v.text_revision
    from public.documents d join public.document_versions v on v.document_id=d.id
    where d.archived_at is null and v.deleted_at is null
      and (case when p_version_id is null then v.id=d.current_version_id else v.id=p_version_id end)
      and (case when coalesce(p_workspace,'personal')='personal' then d.org_id is null else d.org_id=p_workspace::uuid end)
      and case p_scope
        when 'project' then d.project_id=p_project_id
        when 'library' then d.project_id is null and d.workflow_id is null and d.library_kind='file' and d.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
        when 'templates' then d.project_id is null and d.workflow_id is null and d.library_kind='template' and d.user_id=(case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end)
        when 'document' then d.id=p_document_id
        else false end
      and case when p_scope='project' then coalesce(project_allowed,false) and public.org_is_active(d.org_id)
        else public.document_text_access(d.id,p_user_id,p_user_email) end
  ), coverage as (
    select count(*) total_versions,
      count(*) filter(where t.status='ready') indexed_versions,
      count(*) filter(where t.status='failed') failed_versions,
      count(*) filter(where t.status is null or t.status in ('pending','processing')) pending_versions,
      count(*) filter(where t.status='ready' and t.textless_page_count>0) versions_needing_ocr
    -- Each eligible version's text is one primary-key probe (OFFSET 0 keeps
    -- the subquery from being flattened). Joined freely, a reused generic
    -- plan scanned the text table, or its trigram index, across all tenants.
    from eligible e left join lateral (
      select item.status,item.textless_page_count from public.document_version_texts item
      where item.version_id=e.version_id and item.source_revision=e.text_revision and item.extractor_version=1
      offset 0
    ) t on true
  ), hits as (
    select e.*,t.text_content,strpos(lower(t.text_content),lower(p_query)) pos
    from eligible e cross join lateral (
      select item.text_content from public.document_version_texts item
      where item.version_id=e.version_id and item.source_revision=e.text_revision
        and item.status='ready' and item.extractor_version=1 and lower(item.text_content) like
          '%'||replace(replace(replace(lower(p_query),'\','\\'),'%','\%'),'_','\_')||'%' escape '\'
      offset 0
    ) t
    order by e.document_id,e.version_id limit page_limit+1 offset p_offset
  ), page as (
    select * from hits order by document_id,version_id limit page_limit
  )
  select jsonb_build_object('coverage',(select to_jsonb(coverage) from coverage),
    'next_offset',case when (select count(*) from hits)>page_limit then p_offset+page_limit else null end,
    'matches',coalesce((select jsonb_agg(jsonb_build_object(
      'document_id',document_id,'version_id',version_id,'version_number',version_number,
      'revision',text_revision,'filename',filename,'file_type',file_type,'storage_path',storage_path,
      'library_kind',library_kind,'start_char',pos-1,'end_char',pos-1+char_length(p_query),
      'excerpt_start_char',greatest(pos-161,0),
      'excerpt',substring(text_content from greatest(pos-160,1) for char_length(p_query)+320)
    ) order by document_id,version_id) from page),'[]'::jsonb)) into result;
  return result;
end;
$$;
