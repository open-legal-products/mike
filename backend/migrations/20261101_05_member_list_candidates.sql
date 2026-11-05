-- Migration date: 2026-11-01
-- Project and workflow list candidates included every project/workflow in each of the caller's organizations, so
-- a plain member paid a full access verdict for every other member's
-- private item, almost all of which came back null. Membership now only
-- contributes what the ladder can grant a member: public items, every item
-- for an organization Owner, and the member's own overrides. The access
-- ladder still decides every returned role.
create or replace function public.project_list_access(p_user_id text,p_user_email text,p_workspace text default null)
returns table(project_id uuid,role text) language sql stable set search_path=public,pg_temp as $$
  with actor as materialized (
    select case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end id,
      nullif(lower(p_user_email),'') email
  ), candidates as materialized (
    select p.id from public.projects p where p.user_id=(select id from actor)
    -- Membership alone reaches only what the ladder can grant a member:
    -- public projects for everyone, every project for an org Owner (private
    -- and ownerless ones), and per-member overrides. Another member's private
    -- project is never a candidate unless one of those facts holds.
    union select p.id from public.org_members m join public.projects p on p.org_id=m.org_id and p.visibility='organization' where m.user_id=(select id from actor)
    union select p.id from public.org_members m join public.projects p on p.org_id=m.org_id where m.user_id=(select id from actor) and m.role='owner'
    union select o.project_id from public.project_org_access_overrides o where o.user_id=(select id from actor)
    union select g.project_id from public.project_access_grants g where g.email=(select email from actor)
    union select a.item_id from public.org_private_content_access a where a.user_id=(select id from actor) and a.kind='project'
  ), verdicts as materialized (
    select p.id,public.project_access_role(p.id,p.user_id,p.org_id,p_user_id,p_user_email) role
    from candidates c cross join lateral (select item.* from public.projects item where item.id=c.id offset 0) p
    where case when p_workspace is null then true when p_workspace='personal' then p.org_id is null else p.org_id=p_workspace::uuid end
  ) select id,role from verdicts where role is not null;
$$;

create or replace function public.workflow_list_access(p_user_id text,p_user_email text,p_workspace text default null)
returns table(workflow_id uuid,role text) language sql stable set search_path=public,pg_temp as $$
  with actor as materialized (
    select case when p_user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_user_id::uuid end id,
      nullif(lower(p_user_email),'') email
  ), candidates as materialized (
    select w.id from public.workflows w where w.user_id=(select id from actor)
    -- As for projects: public workflows, all of them for an org Owner, and
    -- per-member overrides; never another member's private workflow.
    union select w.id from public.org_members m join public.workflows w on w.org_id=m.org_id and w.visibility='organization' where m.user_id=(select id from actor)
    union select w.id from public.org_members m join public.workflows w on w.org_id=m.org_id where m.user_id=(select id from actor) and m.role='owner'
    union select o.workflow_id from public.workflow_org_access_overrides o where o.user_id=(select id from actor)
    union select g.workflow_id from public.workflow_shares g where lower(g.shared_with_email)=(select email from actor)
    union select a.item_id from public.org_private_content_access a where a.user_id=(select id from actor) and a.kind='workflow'
  ), verdicts as materialized (
    select w.id,public.workflow_access_role(w.id,w.user_id,w.org_id,p_user_id,p_user_email) role
    from candidates c cross join lateral (select item.* from public.workflows item where item.id=c.id offset 0) w
    where case when p_workspace is null then true when p_workspace='personal' then w.org_id is null else w.org_id=p_workspace::uuid end
  ) select id,role from verdicts where role is not null;
$$;
