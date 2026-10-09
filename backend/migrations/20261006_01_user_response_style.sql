-- Migration date: 2026-10-06
-- Response style preferences from Settings > Personalisation (verbosity,
-- headers and lists, tone, language), stored as one JSON object.
--
-- One column rather than one per setting: the set is expected to grow, the
-- values are only ever read together to build a prompt, and nothing queries
-- them. A new setting therefore needs no migration. Only choices that differ
-- from the default are stored; defaults live in the backend
-- (modules/user/user.responseStyle.ts), which also validates every value.
alter table public.user_profiles
  add column if not exists response_style jsonb not null default '{}'::jsonb;

alter table public.user_profiles
  drop constraint if exists user_profiles_response_style_check;
alter table public.user_profiles
  add constraint user_profiles_response_style_check
  check (
    jsonb_typeof(response_style) = 'object'
    and octet_length(response_style::text) <= 2000
  );

-- An earlier draft of this change stored each setting in its own column.
-- Where a database ran that draft, carry any non-default choice across and
-- drop the column (its check constraint goes with it). A no-op elsewhere.
do $$
declare
  draft record;
begin
  for draft in
    select * from (values
      ('verbosity', 'response_verbosity', 'balanced'),
      ('formatting', 'response_formatting', 'balanced'),
      ('tone', 'response_tone', 'balanced'),
      ('language', 'response_language', 'auto')
    ) as d(key, col, def)
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'user_profiles'
        and column_name = draft.col
    ) then
      execute format(
        'update public.user_profiles
            set response_style = response_style || jsonb_build_object(%L, %I)
          where %I is distinct from %L
            and not response_style ? %L',
        draft.key, draft.col, draft.col, draft.def, draft.key
      );
      execute format(
        'alter table public.user_profiles drop column %I', draft.col
      );
    end if;
  end loop;
end $$;

-- Merges a change into one user's response style and returns the result, or
-- null when the user has no profile. A null value in the patch removes that
-- key, which is how a setting returns to its default. Merging in the database
-- keeps two quick changes to different settings from overwriting each other.
create or replace function public.merge_user_response_style(
  p_user_id uuid,
  p_patch jsonb
)
returns jsonb
language sql
set search_path = ''
as $$
  update public.user_profiles
     set response_style = jsonb_strip_nulls(response_style || p_patch),
         updated_at = now()
   where user_id = p_user_id
     and jsonb_typeof(p_patch) = 'object'
  returning response_style;
$$;

revoke all on function public.merge_user_response_style(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.merge_user_response_style(uuid, jsonb)
  to service_role;
