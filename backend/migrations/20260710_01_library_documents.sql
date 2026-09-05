-- Migration date: 2026-07-10
alter table public.documents
  add column if not exists library_kind text default 'file';

update public.documents
set library_kind = 'file'
where library_kind is null;

alter table public.documents
  alter column library_kind set default 'file',
  alter column library_kind set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_library_kind_check'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_library_kind_check
      check (library_kind in ('file', 'template'));
  end if;
end;
$$;

create table if not exists public.library_folders (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  library_kind text not null default 'file',
  name text not null,
  parent_folder_id uuid references public.library_folders(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint library_folders_kind_check
    check (library_kind in ('file', 'template'))
);

alter table public.documents
  add column if not exists library_folder_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'documents_library_folder_id_fkey'
      and conrelid = 'public.documents'::regclass
  ) then
    alter table public.documents
      add constraint documents_library_folder_id_fkey
      foreign key (library_folder_id)
      references public.library_folders(id)
      on delete set null;
  end if;
end;
$$;

create index if not exists idx_library_folders_user_kind
  on public.library_folders(user_id, library_kind);

create index if not exists idx_library_folders_parent
  on public.library_folders(parent_folder_id);

create index if not exists idx_documents_library_kind_folder
  on public.documents(user_id, library_kind, library_folder_id)
  where project_id is null;

revoke all on public.library_folders from anon, authenticated;
