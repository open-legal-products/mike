-- Migration date: 2026-10-18
-- Playbooks no longer have a playbook-wide guidance field; guidance that
-- applies throughout is written as a rule. The application ignores the key
-- already, so drop it from stored playbooks. Runs keep the content they were
-- reviewed with, as a record.
update public.playbooks
set content_json = content_json - 'globalGuidance'
where content_json ? 'globalGuidance';
