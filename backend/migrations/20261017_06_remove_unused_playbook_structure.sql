-- Migration date: 2026-10-17
-- Word structure is used only while compiling an import. Rules retain their
-- source references and the original file is stored separately; no reader
-- uses this duplicate parsed copy.
alter table public.playbooks drop column if exists source_structure_json;
