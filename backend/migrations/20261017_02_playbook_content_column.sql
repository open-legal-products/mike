-- Migration date: 2026-10-17
-- A playbook has no draft/published split: its stored rules are its content.
do $$
begin
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'playbooks' and column_name = 'draft_json') then
    alter table public.playbooks rename column draft_json to content_json;
  end if;
end $$;
