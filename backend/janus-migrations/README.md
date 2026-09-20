# Janus-side migrations (Mike Supabase, applied by hand)

The contract-review tables (`reviews`, `review_feedback`, `manual_comments`,
`missed_clause_feedback`, `clause_library`, `clause_versions`,
`negotiation_points`, `playbook_rules`, `user_roles`, `clients`) were created in
Mike's Supabase from the Janus schema (2026-06-21) and are intentionally NOT part
of `backend/schema.sql` or `backend/migrations/`: upstream's fresh-install CI has
no Janus tables, so any `alter table reviews …` there would break it.

Apply these files in filename order in the Supabase SQL editor of the Mike
project, and record the last applied filename in the migration handoff doc.
Every file is idempotent (`if not exists` / `add column if not exists`).
