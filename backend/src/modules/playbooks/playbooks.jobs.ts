// Playbook reviews and imports as durable db_jobs.
//
// Both take minutes of model time, so the routes answer 202 with the stored
// row and leave the work to a job. The job row in db_jobs is what survives a
// restart: a worker that dies mid-run leaves its claim to go stale, and the
// runner re-claims it (lib/dbq/runner.ts). The handlers below make that
// re-run safe — a finished row is left alone, and every outcome is written
// with a guard on the row still running (see runPlaybookReview and
// compilePlaybookImport), so two claims of one job cannot both record one.

import { deleteFile, downloadFile } from "../../lib/storage";
import { safeError } from "../../lib/safeError";
import { AppError } from "../../lib/appError";
import { reportError, setOperation } from "../../lib/observability/sentry";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
  DbJobDeferredError,
  type Db,
  type DbJob,
  type DbJobHandler,
} from "../../lib/dbq/types";
import { createServerSupabase } from "../../lib/supabase";
import {
  beginPlaybookImport,
  beginPlaybookReview,
  compilePlaybookImport,
  INTERRUPTED_IMPORT_ERROR,
  INTERRUPTED_RUN_ERROR,
  MAX_PLAYBOOK_IMPORT_BYTES,
  playbookImportDocument,
  playbookImportJobKey,
  PlaybookRequestError,
  playbookReviewJobKey,
  playbookReviewWork,
  playbookWorkAttended,
  runPlaybookReview,
  type PlaybookImport,
  type PlaybookImportRequest,
  type PlaybookImportWork,
  type PlaybookReviewInput,
  type PlaybookReviewRequest,
} from "./playbooks.operations";
import { isStagedPlaybookImportKey } from "./playbooks.staging";
import { reportPlaybookFailure, type PlaybookJobKind } from "./playbooks.reporting";
import {
  recordPlaybookImportAudit,
  recordPlaybookRunAudit,
} from "./playbooks.audit";

export const PLAYBOOK_REVIEW_JOB = "playbook.review";
export const PLAYBOOK_IMPORT_JOB = "playbook.import";

/**
 * Attempts per job. Only a crash or an unrecordable outcome uses one: a
 * review or import that fails on its own terms (the model refused, the file
 * was unreadable) is recorded on its row and the job ends, because running
 * the model again on the same input costs the user money to fail again.
 */
const PLAYBOOK_JOB_ATTEMPTS = 3;
/** How long a re-claimed job waits for a still-heartbeating earlier claim. */
const DEFER_WHILE_ATTENDED_MS = 60_000;

/** Where an import's file is read from when its job runs. */
export type PlaybookImportSource =
  | { storageKey: string }
  | { documentId: string };

export type PlaybookImportJobPayload = PlaybookImportWork & PlaybookImportSource;

type Table = "playbook_runs" | "playbook_imports";

async function loadRow(
  db: Db,
  table: Table,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from(table)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return (data as Record<string, unknown> | null) ?? null;
}

/**
 * Whether this claim should run the work, or leave the row alone.
 *
 * A row that is gone or no longer running is finished: nothing to do. A
 * re-claimed job (attempts > 1) whose row is still being heartbeated is a job
 * the runner took back from a worker that is in fact alive — the db_jobs
 * lease is shorter than a long review — so it defers rather than run the
 * model a second time beside it.
 */
async function claimRow(
  db: Db,
  table: Table,
  id: string,
  job: DbJob,
): Promise<Record<string, unknown> | null> {
  const row = await loadRow(db, table, id);
  if (!row || row.status !== "running") return null;
  if (job.attempts > 1 && playbookWorkAttended(row))
    throw new DbJobDeferredError(
      new Date(Date.now() + DEFER_WHILE_ATTENDED_MS).toISOString(),
      "playbook_work_attended",
    );
  return row;
}

/**
 * Run the work; if it throws, end the job anyway when the row recorded an
 * outcome (the failure is the user's to see, not the queue's to retry), and
 * rethrow only when the row is still running, so the queue tries again.
 */
async function untilRecorded(
  db: Db,
  table: Table,
  id: string,
  work: () => Promise<unknown>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const row = await loadRow(db, table, id);
    if (!row || row.status !== "running") return;
    throw error;
  }
}

/**
 * Mark a row failed with a message written for the user, once. Returns the
 * row when this call is the one that failed it, so its outcome is audited by
 * exactly one caller.
 */
async function markFailed(
  db: Db,
  table: Table,
  id: string,
  message: string,
): Promise<Record<string, unknown> | null> {
  const completedAt = new Date().toISOString();
  const { data, error } = await db
    .from(table)
    .update({
      status: "failed",
      error: message,
      completed_at: completedAt,
      updated_at: completedAt,
    })
    .eq("id", id)
    .eq("status", "running")
    .select("*");
  if (error) throw error;
  return ((data as Record<string, unknown>[] | null) ?? [])[0] ?? null;
}

export async function handlePlaybookReview(db: Db, job: DbJob): Promise<void> {
  setOperation("playbooks.review");
  const input = job.payload as unknown as PlaybookReviewInput;
  const row = await claimRow(db, "playbook_runs", input.runId, job);
  if (!row) return;
  // Re-run from the row: the rules snapshot (content_json), model, mode, and
  // scope were fixed when the review was requested.
  await untilRecorded(db, "playbook_runs", input.runId, () =>
    runPlaybookReview(db, playbookReviewWork(row, input)),
  );
}

/** Retries exhausted: the run ends with the message an interrupted run shows. */
export async function markPlaybookReviewJobFailed(
  db: Db,
  job: DbJob,
): Promise<void> {
  const input = job.payload as unknown as PlaybookReviewInput;
  const row = await markFailed(
    db,
    "playbook_runs",
    input.runId,
    INTERRUPTED_RUN_ERROR,
  );
  if (row)
    await recordPlaybookRunAudit(db, playbookReviewWork(row, input), {
      status: "failed",
    });
}

/** Remove a staged upload once nothing will read it again. */
async function clearStagedImport(payload: PlaybookImportJobPayload) {
  if (!("storageKey" in payload)) return;
  // Only an object the upload route minted for this user (see
  // playbooks.staging.ts): the payload is ours, but a key is a delete target.
  if (!isStagedPlaybookImportKey(payload.userId, payload.storageKey)) return;
  await deleteFile(payload.storageKey).catch((error) => {
    // The upload is orphaned in storage: worth knowing, never worth failing
    // an import that has already recorded its outcome.
    reportPlaybookFailure(error, {
      stage: "import.cleanup",
      level: "warning",
      jobKind: "playbook.import",
      ids: { import_id: payload.attemptId },
    });
    console.warn("[playbooks] staged upload cleanup failed", {
      storageKey: payload.storageKey,
      error: safeError(error),
    });
  });
}

/** The file an import compiles, or a reason written for the user. */
async function readImportFile(
  db: Db,
  payload: PlaybookImportJobPayload,
): Promise<Buffer> {
  let bytes: ArrayBuffer | null;
  if ("storageKey" in payload) {
    if (!isStagedPlaybookImportKey(payload.userId, payload.storageKey))
      throw new PlaybookRequestError("Upload the playbook before importing it.");
    bytes = await downloadFile(payload.storageKey);
  } else {
    const document = await playbookImportDocument(
      db,
      payload.userId,
      payload.userEmail,
      payload.documentId,
    );
    bytes = await downloadFile(document.storagePath);
  }
  if (!bytes)
    throw new PlaybookRequestError("The uploaded playbook could not be read.");
  if (bytes.byteLength > MAX_PLAYBOOK_IMPORT_BYTES)
    throw new PlaybookRequestError("The uploaded playbook is too large.");
  return Buffer.from(bytes);
}

export async function handlePlaybookImport(db: Db, job: DbJob): Promise<void> {
  setOperation("playbooks.import");
  const payload = job.payload as unknown as PlaybookImportJobPayload;
  const row = await claimRow(db, "playbook_imports", payload.attemptId, job);
  if (row)
    await untilRecorded(db, "playbook_imports", payload.attemptId, () =>
      compilePlaybookImport(db, payload, () => readImportFile(db, payload)),
    );
  // Reached only once the attempt has an outcome; a retry still needs the file.
  await clearStagedImport(payload);
}

/** Retries exhausted: the attempt ends as interrupted, and its upload goes. */
export async function markPlaybookImportJobFailed(
  db: Db,
  job: DbJob,
): Promise<void> {
  const payload = job.payload as unknown as PlaybookImportJobPayload;
  const row = await markFailed(
    db,
    "playbook_imports",
    payload.attemptId,
    INTERRUPTED_IMPORT_ERROR,
  );
  if (row)
    await recordPlaybookImportAudit(db, payload, {
      failedStage: typeof row.stage === "string" ? row.stage : null,
    });
  await clearStagedImport(payload);
}

/**
 * Hand the work to the queue. With the runner switched off
 * (DB_JOBS_ENABLED=false) nothing would ever claim the job, so the same
 * handler runs here instead, detached from the request as reviews and imports
 * ran before they were jobs; the row heartbeat is then what keeps it from
 * reading as interrupted. If enqueueing fails the row is failed at once
 * rather than left running with no job behind it.
 */
async function dispatch(
  db: Db,
  kind: string,
  dedupeKey: string,
  payload: Record<string, unknown>,
  handler: DbJobHandler,
  onFailure: (db: Db, job: DbJob) => Promise<void>,
): Promise<void> {
  const now = new Date().toISOString();
  const job: DbJob = {
    id: `inline:${dedupeKey}`,
    kind,
    payload,
    status: "running",
    attempts: 1,
    max_attempts: 1,
    run_at: now,
    claimed_at: now,
    finished_at: null,
    last_error: null,
    dedupe_key: dedupeKey,
    result: null,
    created_at: now,
  };
  if (!dbJobsEnabled()) {
    void handler(db, job).catch(async (error) => {
      // The in-process twin of the runner's terminal report: with the
      // runner off, nothing else hears of a job that ended this way.
      reportPlaybookFailure(error, {
        stage: "job.terminal",
        jobKind: kind as PlaybookJobKind,
        ids: {
          run_id: typeof payload.runId === "string" ? payload.runId : undefined,
          import_id:
            typeof payload.attemptId === "string" ? payload.attemptId : undefined,
        },
      });
      console.warn("[playbooks] inline job failed", {
        kind,
        error: safeError(error),
      });
      await onFailure(db, job).catch((hookError: unknown) =>
        reportFailureHookCrash(hookError, kind),
      );
    });
    return;
  }
  try {
    await enqueueDbJob(db, {
      kind,
      payload,
      dedupeKey,
      maxAttempts: PLAYBOOK_JOB_ATTEMPTS,
    });
  } catch (error) {
    await onFailure(db, job).catch((hookError: unknown) =>
      reportFailureHookCrash(hookError, kind),
    );
    throw error;
  }
}

/**
 * The failure hook could not record the row's outcome: the review or import
 * stays "running" until it reads as interrupted. The original failure is
 * already reported (or rethrown) by the caller, so this names the second,
 * independent fault the runner would otherwise have been the only one to see.
 */
function reportFailureHookCrash(hookError: unknown, kind: string): void {
  reportError(
    new AppError(
      "dbq.failure_hook_crashed",
      "Playbook job failure hook crashed",
      { cause: hookError },
    ),
    {
      tags: { component: "playbooks", stage: "failure-hook", job_kind: kind },
    },
  );
  console.warn("[playbooks] job failure hook crashed", {
    kind,
    error: safeError(hookError),
  });
}

/**
 * Checks and records a review, then queues it: the run is returned as soon as
 * it is stored, still running, and the job records how it ended.
 */
export async function queuePlaybookReview(args: PlaybookReviewRequest) {
  const db = args.db ?? createServerSupabase();
  const { run, work } = await beginPlaybookReview({ ...args, db });
  const input: PlaybookReviewInput = {
    runId: work.runId,
    userId: work.userId,
    documentText: work.documentText,
    instructions: work.instructions,
    userEmail: work.userEmail,
    expectedVersion: work.expectedVersion,
  };
  await dispatch(
    db,
    PLAYBOOK_REVIEW_JOB,
    playbookReviewJobKey(work.runId),
    input,
    handlePlaybookReview,
    markPlaybookReviewJobFailed,
  );
  return run;
}

/**
 * Checks and records an import, then queues its compile. A saved document is
 * checked (access, size) before anything is recorded; a staged upload has
 * already been checked by the route. The staged object then belongs to the
 * job, which removes it once the attempt has an outcome.
 */
export async function queuePlaybookImport(
  args: Omit<PlaybookImportRequest, "filename" | "size"> & {
    source:
      | { storageKey: string; filename: string; size: number }
      | { documentId: string };
  },
): Promise<PlaybookImport> {
  const db = args.db ?? createServerSupabase();
  const { source, ...request } = args;
  const file =
    "documentId" in source
      ? await playbookImportDocument(
          db,
          args.userId,
          args.userEmail,
          source.documentId,
        )
      : source;
  const { attempt, work } = await beginPlaybookImport({
    ...request,
    db,
    filename: file.filename,
    size: file.size,
  });
  const payload: PlaybookImportJobPayload = {
    ...work,
    ...("documentId" in source
      ? { documentId: source.documentId }
      : { storageKey: source.storageKey }),
  };
  await dispatch(
    db,
    PLAYBOOK_IMPORT_JOB,
    playbookImportJobKey(work.attemptId),
    payload,
    handlePlaybookImport,
    markPlaybookImportJobFailed,
  );
  return attempt;
}
