-- Migration date: 2026-10-24
--
-- Settings > Privacy & Data now deletes, and exports, one workspace at a
-- time by each row's org_id. A chat, tabular review or document inside a
-- project carries its project's organization: the sync_project_child_org_id
-- triggers set it on insert, and a project's organization never changes
-- afterwards. Re-derive it here anyway, so that a row which somehow
-- disagrees with its project (a manual edit, an unusual install) is filed
-- under the right workspace before a Personal delete or export relies on it.
--
-- Updates only rows that disagree, which on a normal database is none.
-- Safe to re-run.

update public.chats chat
set org_id = project.org_id
from public.projects project
where chat.project_id = project.id
  and chat.org_id is distinct from project.org_id;

update public.tabular_reviews review
set org_id = project.org_id
from public.projects project
where review.project_id = project.id
  and review.org_id is distinct from project.org_id;

update public.documents document
set org_id = project.org_id
from public.projects project
where document.project_id = project.id
  and document.org_id is distinct from project.org_id;
