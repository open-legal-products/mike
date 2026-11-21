-- Migration date: 2026-11-18
-- Connector write actions (MCP write tools, Gmail/Calendar writes, Drive
-- create/move/trash) now wait for the user's approval unless the user turns
-- "Ask for permission for write actions" off.
--
-- The column defaulted to false, and nothing recorded whether a false value
-- was the user's choice or just that default, so existing rows are switched
-- to true. The backfill runs only while a table's default is still false,
-- i.e. on the first application: a replay never overwrites an opt-out the
-- user made after this migration.
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'user_mcp_connectors',
    'user_google_drive_tokens',
    'user_google_workspace_tokens'
  ] loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = v_table
        and column_name = 'require_write_approval'
        and column_default = 'false'
    ) then
      execute format(
        'update public.%I set require_write_approval = true where not require_write_approval',
        v_table
      );
      execute format(
        'alter table public.%I alter column require_write_approval set default true',
        v_table
      );
    end if;
  end loop;
end $$;
