-- Phase 5 slice 4: AI revisions projected into the original DOCX as tracked changes.
-- One row per (review, revision id). `change_id`/`del_w_id`/`ins_w_id` are the OOXML
-- ids written by backend/src/lib/docxTrackedChanges.ts; a row with `error` set could
-- not be anchored and stays card-only. The working (redlined) DOCX key is recorded on
-- reviews.contract_redline_path; the untouched upload stays at contract_docx_path.

alter table public.reviews add column if not exists contract_redline_path text;

create table if not exists public.review_revision_edits (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null references public.reviews(id) on delete cascade,
  revision_id text not null,
  change_id text,
  del_w_id text,
  ins_w_id text,
  deleted_text text,
  inserted_text text,
  author text,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (review_id, revision_id)
);

create index if not exists review_revision_edits_review_idx on public.review_revision_edits(review_id);

alter table public.review_revision_edits enable row level security;
-- Backend-only (service role); browsers never read this table directly.
revoke all on public.review_revision_edits from anon, authenticated;
grant select, insert, update, delete on public.review_revision_edits to service_role;

notify pgrst, 'reload schema';
