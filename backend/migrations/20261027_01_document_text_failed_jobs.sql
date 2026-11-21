-- Migration date: 2026-10-27
-- A document.extract_text job that kills its worker (out of memory, or a parse
-- that never yields) is failed by claim_db_jobs' stale sweep, which runs no
-- TypeScript failure hook. Its text row stayed 'processing', and
-- backfill_document_text treats that as unfinished, so it queued the same file
-- again with a fresh attempt budget, forever. Fail the text row whenever its
-- job fails, whichever path fails the job.

create or replace function public.document_text_job_failed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v uuid; r uuid;
begin
  begin
    v := (new.payload->>'versionId')::uuid;
    r := (new.payload->>'revision')::uuid;
  exception when invalid_text_representation then
    return null;
  end;
  update public.document_version_texts
     set status='failed',text_content=null,error_code='extraction_failed',updated_at=now()
   where version_id=v and source_revision=r and status in ('pending','processing');
  return null;
end;
$$;

drop trigger if exists document_text_job_failed on public.db_jobs;
create trigger document_text_job_failed after update of status on public.db_jobs
  for each row when (new.kind='document.extract_text' and new.status='failed' and old.status is distinct from 'failed')
  execute function public.document_text_job_failed();

revoke all on function public.document_text_job_failed() from public,anon,authenticated;

-- Release rows already caught in the loop: unfinished text whose job for the
-- same revision has failed and has no live successor.
update public.document_version_texts t
   set status='failed',text_content=null,error_code='extraction_failed',updated_at=now()
 where t.status in ('pending','processing')
   and exists(select 1 from public.db_jobs j
     where j.dedupe_key='document.text:'||t.version_id||':'||t.source_revision and j.status='failed')
   and not exists(select 1 from public.db_jobs j
     where j.dedupe_key='document.text:'||t.version_id||':'||t.source_revision and j.status in ('pending','running'));
