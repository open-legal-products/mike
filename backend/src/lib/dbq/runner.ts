// The DB-queue runner: polls public.db_jobs, executes handlers, applies the
// retry/backoff state machine, and sweeps old rows.
//
// Runs BY DEFAULT in every deployment — the whole point of this queue is
// durability without new infrastructure, so unlike the Redis workers there is
// no opt-in flag; DB_JOBS_ENABLED=false exists only as an operational escape
// hatch — and it is honored on BOTH sides. The runner stops, and producers
// stop acknowledging work nothing will run: account deletion falls back to
// the inline cascade, async exports answer 503. "Enqueue anyway and let it
// wait" was the old reading, and it let a 204 stand for an erasure that
// never happened. Split worker topology is WORKERS_MODE=none, not this
// flag. Polling a partial index every few seconds costs one cheap indexed
// query, and FOR UPDATE SKIP LOCKED in the claim RPC makes any number of
// backend replicas partition the work safely.

import { createServerSupabase } from "../supabase";
import { jobErrorMessage } from "./jobError";
import { claimIdentity, settleClaim, type Settlement, type SettlementPatch } from "./claim";
import { executeWithClaim, CLAIM_STALE_SECONDS, assertValidExecutionPolicies } from "./execution";
import { safeError } from "../safeError";
import { deleteFile } from "../storage";
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import { redisEnabled } from "./driver";
import {
    DbJobDeferredError,
    type Db,
    type DbJob,
    type DbJobHandlers,
    type DbJobExecutionOptions,
    type DbJobExecutionPolicies,
} from "./types";
import { reportError } from "../observability/sentry";
import {
    createPollFailureGate,
    type PollFailureGate,
} from "../observability/pollFailureGate";
import { asReportableError } from "../httpError";

/**
 * Poll cadence depends on the driver: with Redis configured, BullMQ delivers
 * jobs instantly and the poller is only a BACKSTOP for lost deliveries, so
 * it idles at 60s; without Redis the poller IS the delivery mechanism and
 * runs every 5s. DB_JOBS_POLL_MS overrides either.
 */
function pollMs(): number {
    const raw = Number(process.env.DB_JOBS_POLL_MS);
    if (Number.isFinite(raw) && raw >= 250) return raw;
    return redisEnabled() ? 60_000 : 5_000;
}
/** Ceiling for the claim interval while every claim keeps failing. */
const CLAIM_MAX_BACKOFF_MS = 60_000;

/**
 * The claim fails identically on every tick while its cause lasts (RPC
 * missing because migrations were not applied, database unreachable). One
 * report per failure class, quiet repeats with a once-a-minute count, and a
 * backed-off poll — reporting every tick filed 1,167 events plus 1,227
 * console duplicates from one worker thread (MIKE-BACKEND-P / -3).
 */
export function createDbJobClaimGate(): PollFailureGate {
    return createPollFailureGate({
        label: "[dbq] claim",
        baseDelayMs: pollMs,
        maxDelayMs: CLAIM_MAX_BACKOFF_MS,
    });
}
const defaultClaimGate = createDbJobClaimGate();

const CLAIM_BATCH = 5;
/**
 * A "running" job whose claim is older than this is presumed crashed.
 * Exported because a handler that claims sibling rows of its own kind (the
 * document.cleanup coalescer) has to use the same stale threshold this loop
 * does, or the two disagree about who owns a row.
 */
export const STALE_SECONDS = CLAIM_STALE_SECONDS;
/** Retention: how long finished rows are kept for inspection. */
const DONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const RETRY_UNTIL_SUCCESS_KINDS = new Set(["storage.cleanup", "document.cleanup"]);

/**
 * Exponential backoff for retries: 30s, 90s, 270s, ... capped at 30 min.
 * `attempts` is the attempt that just failed (claim increments it), so the
 * first retry waits 30s.
 */
export function retryDelayMs(attempts: number): number {
    const base = 30_000 * Math.pow(3, Math.max(0, attempts - 1));
    return Math.min(base, 30 * 60 * 1000);
}

/**
 * Domain cleanup to run when a kind's job fails PERMANENTLY (attempts
 * exhausted). The generic state machine only flips the db_jobs row to
 * "failed" — kinds whose failure must also flip domain state (a document to
 * "error", a row's cells to "error") register a hook here. Hook errors are
 * contained: the row still lands in "failed" for inspection.
 */
export type DbJobFailureHook = (db: Db, job: DbJob) => Promise<void>;


/**
 * "Retrying cannot fix this." A handler throws it when the job is refused by
 * a rule, not defeated by a transient fault — and the state machine skips
 * straight to `failed`, the same way an unknown kind does.
 *
 * The retry budget is for flaky networks and busy databases. Spending 20
 * attempts over hours on a job the domain will refuse identically every time
 * (account deletion for the only admin of an organization that still has
 * members) buries the real reason under a wall of repeats and leaves the
 * user's request in limbo far longer than it needs to be.
 */
export class NonRetryableJobError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NonRetryableJobError";
    }
}

/**
 * Run one claimed job through its handler and persist the outcome:
 *   handler resolves        -> done (+ optional result)
 *   handler throws, retries -> pending again with run_at pushed back
 *   handler throws, spent   -> failed (terminal, kept for inspection)
 *   handler throws NonRetryableJobError -> failed immediately
 *   unknown kind            -> failed immediately (retrying can't fix it)
 * Exported for unit tests; the poll loop below is just claim + fan-in.
 */
export async function processClaimedJob(
    db: Db,
    handlers: DbJobHandlers,
    job: DbJob,
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
    options: DbJobExecutionOptions = {},
): Promise<void> {
    if (options.signal?.aborted) return;
    const policy = options.policies?.[job.kind];
    if (policy && RETRY_UNTIL_SUCCESS_KINDS.has(job.kind))
        throw new Error("cleanup_claim_renewal_not_supported");
    const claim = Object.freeze(claimIdentity(job));
    /** Persist once using the captured fence and report unknown writes without retrying them. */
    const settle = async (patch: SettlementPatch): Promise<Settlement> => {
        const outcome = await settleClaim(db, claim, policy ? { result: job.result, ...patch } : patch, Boolean(policy));
        if (outcome.kind === "outcome_unknown") {
            reportInfrastructureFailure(job.id, "settlement", outcome.error);
        }
        return outcome;
    };

    const retryUntilSuccess = RETRY_UNTIL_SUCCESS_KINDS.has(job.kind);
    const handler = handlers[job.kind];
    if (!handler && !retryUntilSuccess) {
        const outcome = await settle({
            status: "failed",
            finished_at: new Date().toISOString(),
            last_error: `unknown job kind: ${job.kind}`,
        });
        if (outcome.kind !== "committed") return;
        const unknownKind = new Error(`Unknown db_jobs kind: ${job.kind}`);
        reportError(unknownKind, {
            tags: { component: "dbq", job_kind: job.kind },
            extra: { job_id: job.id },
            fingerprint: ["dbq-unknown-kind", job.kind],
        });
        // Carry the reported object so the console bridge files no duplicate.
        console.error("[dbq] unknown job kind", {
            id: job.id,
            kind: job.kind,
            error: unknownKind,
        });
        return;
    }

    let execution: { ok: true; result: Record<string, unknown> | void } | { ok: false; error: unknown };
    if (policy && handler) {
        const outcome = await executeWithClaim(db, job, claim, handler, policy, options.signal);
        if (outcome.kind === "closed") {
            console.log("[dbq] execution closed", { id: claim.id, reason: outcome.reason });
            return;
        }
        execution = outcome.kind === "completed"
            ? { ok: true, result: outcome.result }
            : { ok: false, error: outcome.error };
    } else {
        try {
            if (!handler) throw new Error(`unknown job kind: ${job.kind}`);
            execution = { ok: true, result: await handler(db, job) };
        } catch (error) {
            execution = { ok: false, error };
        }
    }
    // A database exception here is NOT a handler failure. Never retry a
    // possibly committed success or invoke a domain hook on its behalf.
    if (execution.ok) {
        await settle({
            status: "done",
            finished_at: new Date().toISOString(),
            last_error: null,
            ...(execution.result ? { result: execution.result } : {}),
        });
        return;
    }
    {
        const err = execution.error;
        const message = jobErrorMessage(err);
        // Destructive memory operations remove version metadata only after a
        // cleanup job owns the object path. That job is the last durable
        // pointer, so storage cleanup must retry until success rather than
        // becoming a finite-attempt failed row that a later sweep can erase.
        // A NonRetryableJobError is the handler saying the job can never
        // succeed, which wins over both the retry budget and retry-until-success.
        const deferred = err instanceof DbJobDeferredError;
        const spent =
            err instanceof NonRetryableJobError ||
            (!deferred &&
                job.attempts >= job.max_attempts &&
                !retryUntilSuccess);
        const deferredAt = deferred ? Date.parse(err.runAt) : Number.NaN;
        const delayMs = deferred
            ? Math.max(
                  1_000,
                  (Number.isFinite(deferredAt) ? deferredAt : Date.now() + 60_000) -
                      Date.now(),
              )
            : retryDelayMs(job.attempts);
        const settlement = await settle(
                spent
                    ? {
                          status: "failed",
                          finished_at: new Date().toISOString(),
                          last_error: message,
                      }
                      : {
                          status: "pending",
                          run_at: deferred && Number.isFinite(deferredAt)
                              ? new Date(deferredAt).toISOString()
                              : new Date(Date.now() + delayMs).toISOString(),
                          last_error: message,
                          ...(deferred
                              ? { attempts: Math.max(0, job.attempts - 1) }
                              : {}),
                          ...(retryUntilSuccess
                              ? { max_attempts: 2_147_483_647 }
                              : {}),
                      },
        );
        if (settlement.kind === "committed" && spent) {
            const hook = failureHooks[job.kind];
            if (hook) {
                try {
                    await hook(db, job);
                } catch (hookErr) {
                    reportError(hookErr, {
                        tags: { component: "dbq", job_kind: job.kind, stage: "failure-hook" },
                        extra: { job_id: job.id },
                    });
                    console.error("[dbq] failure hook crashed", {
                        id: job.id,
                        kind: job.kind,
                        hookErr,
                    });
                }
            }
        } else if (settlement.kind === "committed" && redisEnabled()) {
            // Redeliver the retry at its backoff time so it doesn't wait for
            // the (slow, backstop-cadence) poller. Best-effort — the poller
            // covers a failed redelivery.
            try {
                await enqueueAppJobDelivery(job.id, {
                    delayMs,
                    attempt: job.attempts,
                });
            } catch (redeliverErr) {
                console.error(
                    "[dbq] retry redelivery failed; poll backstop will run it:",
                    redeliverErr instanceof Error
                        ? redeliverErr.message
                        : redeliverErr,
                );
            }
        }
        // Every failed attempt is reported — a bug shows up on attempt one,
        // not after the backoff ladder has burned an hour. Retryable attempts
        // are warnings; the terminal failure is the error, and both group per
        // job kind so one bad handler is one issue with a hit count. A
        // deferral is the handler asking to run later, not a failure, so it
        // is logged but never reported.
        // A handler can reject with a PostgREST plain object: give it a stack
        // and keep its code on the cause chain (failure_code), as the claim
        // path does. Errors pass through unchanged.
        const reportable = asReportableError(err, processClaimedJob);
        if (!deferred) {
            reportError(reportable, {
                level: spent && settlement.kind === "committed" ? "error" : "warning",
                tags: {
                    component: "dbq",
                    job_kind: job.kind,
                    attempt: job.attempts,
                    max_attempts: job.max_attempts,
                    terminal: spent && settlement.kind === "committed",
                },
                extra: { job_id: job.id, dedupe_key: job.dedupe_key ?? null },
            });
        }
        if (settlement.kind !== "committed") {
            // The handler failed, but no terminal/retry state was confirmed.
            // Do not print provider/database free text on this new path.
            console.log("[dbq] handler outcome not settled", {
                id: job.id, outcome: settlement.kind,
            });
            return;
        }
        const summary = { id: job.id, kind: job.kind, attempts: job.attempts, message };
        if (deferred) {
            // Not a failure, and not reported: console.error would reach
            // Sentry through the console bridge as an error event.
            console.log("[dbq] job deferred", summary);
        } else {
            // The reported Error rides along so the console bridge recognises
            // it and files no second, context-free "Failure in application"
            // issue (MIKE-BACKEND-G mirrored MIKE-BACKEND-F 1:1).
            console.error(
                spent
                    ? "[dbq] job permanently failed"
                    : "[dbq] job failed; will retry",
                { ...summary, error: reportable },
            );
        }
    }
}

/** New infrastructure diagnostics contain categories, never dependency free text. */
function reportInfrastructureFailure(id: string, stage: "settlement" | "dispatch", error: unknown): void {
    const failure = new Error(`db_job_${stage}_${safeError(error).category}`);
    reportError(failure, { tags: { component: "dbq", stage }, extra: { job_id: id } });
    console.error("[dbq] infrastructure operation failed", { id, stage, error: failure });
}

/** One poll tick: claim a batch and run every claimed job to completion. */
export async function runDbJobTick(
    db: Db,
    handlers: DbJobHandlers,
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
    claimGate: PollFailureGate = defaultClaimGate,
    options: DbJobExecutionOptions = {},
): Promise<number> {
    if (options.signal?.aborted) return 0;
    const { data, error } = await db.rpc("claim_db_jobs", {
        p_limit: CLAIM_BATCH,
        p_stale_seconds: STALE_SECONDS,
    });
    if (error) {
        // Table/function missing (migration not applied yet) or transient DB
        // trouble: log and try again later — never crash the server.
        //
        // asReportableError keeps the PostgREST object as the cause, so its
        // `code` (PGRST202 = RPC missing) reaches failure_code and the issue
        // title says why; re-wrapping `error.message` in a new Error lost it.
        const failure = asReportableError(error, runDbJobTick);
        if (claimGate.failure(failure).report) {
            reportError(failure, {
                tags: { component: "dbq", stage: "claim" },
                fingerprint: ["dbq-claim-failed"],
            });
            // The Error object, not a string: the console bridge dedupes a
            // reported object, a message string it files as a new event.
            console.error("[dbq] claim failed", failure);
        }
        return 0;
    }
    claimGate.success();
    if (options.signal?.aborted) return 0;
    const jobs = (data ?? []) as DbJob[];
    // allSettled defensively: processClaimedJob handles its own errors, but
    // one job's unexpected rejection must never abandon the rest of a batch.
    const outcomes = await Promise.allSettled(
        jobs.map((job) => processClaimedJob(db, handlers, job, failureHooks, options)),
    );
    outcomes.forEach((outcome, index) => {
        if (outcome.status === "rejected")
            reportInfrastructureFailure(jobs[index].id, "dispatch", outcome.reason);
    });
    return jobs.length;
}

/**
 * Retention sweep. Export artifacts get their storage object removed before
 * the row goes (the row's result is the only pointer to the file — deleting
 * it first would leak the object forever).
 */
export async function runDbJobRetentionSweep(
    db: Db,
    opts?: {
        deleteStoredFile?: (path: string) => Promise<void>;
        exportRetentionMs?: number;
    },
): Promise<void> {
    const deleteStoredFile = opts?.deleteStoredFile ?? deleteFile;
    const exportRetentionMs =
        opts?.exportRetentionMs ?? 24 * 60 * 60 * 1000;

    // 1. Expire export artifacts (their download links stop working here —
    //    documented as a 24h availability window).
    const exportCutoff = new Date(Date.now() - exportRetentionMs).toISOString();
    const { data: expired } = await db
        .from("db_jobs")
        .select("id, result")
        .eq("kind", "export.build")
        .eq("status", "done")
        .lt("finished_at", exportCutoff)
        .limit(100);
    for (const row of (expired ?? []) as Pick<DbJob, "id" | "result">[]) {
        const path = row.result?.storage_path;
        if (typeof path === "string" && path.length > 0) {
            try {
                await deleteStoredFile(path);
            } catch (err) {
                // Keep the row so the next sweep retries the file delete.
                console.error("[dbq] export artifact delete failed", {
                    id: row.id,
                    err,
                });
                continue;
            }
        }
        await db.from("db_jobs").delete().eq("id", row.id);
    }

    // 2. Drop old finished rows — EXCEPT export.build. Step 1 is the only
    //    deleter of done export rows because it removes the storage object
    //    before the row: a row it kept after a failed file delete is retry
    //    state, and this generic purge sweeping it at the 7-day boundary
    //    would erase the only pointer to the artifact and leak a full copy
    //    of the user's data — the exact leak the docstring above promises
    //    not to commit.
    const doneCutoff = new Date(Date.now() - DONE_RETENTION_MS).toISOString();
    await db
        .from("db_jobs")
        .delete()
        .eq("status", "done")
        .neq("kind", "export.build")
        .lt("finished_at", doneCutoff);
    const failedCutoff = new Date(
        Date.now() - FAILED_RETENTION_MS,
    ).toISOString();
    await db
        .from("db_jobs")
        .delete()
        .eq("status", "failed")
        .neq("kind", "storage.cleanup")
        .neq("kind", "document.cleanup")
        .lt("finished_at", failedCutoff);

    // 3. Curator receipts. memory_consolidation_results rows exist so a
    //    retried memory.consolidate job applies each scope once; they are
    //    useless after the job row itself has been swept, and nothing else
    //    deletes them.
    await db
        .from("memory_consolidation_results")
        .delete()
        .lt("created_at", doneCutoff);
}

type RunnerGeneration = {
    controller: AbortController;
    timers: ReturnType<typeof setTimeout>[];
    tick: Promise<unknown> | null;
    sweep: Promise<unknown> | null;
};
let generation: RunnerGeneration | null = null;

/** Respect the operational queue switch shared by producers and consumers. */
export function dbJobsEnabled(): boolean {
    return process.env.DB_JOBS_ENABLED !== "false";
}

/** Each start owns its timers and signal; an older drain cannot stop a restart. */
export function startDbJobRunner(
    handlers: DbJobHandlers,
    failureHooks: Readonly<Record<string, DbJobFailureHook>> = {},
    policies: DbJobExecutionPolicies = {},
): void {
    if (!dbJobsEnabled()) {
        console.log("[dbq] disabled via DB_JOBS_ENABLED=false");
        return;
    }
    if (generation && !generation.controller.signal.aborted) return;
    assertValidExecutionPolicies(policies);
    const current: RunnerGeneration = {
        controller: new AbortController(), timers: [], tick: null, sweep: null,
    };
    generation = current;
    const db = createServerSupabase();
    const signal = current.controller.signal;
    /** Run at most one claim batch for this generation, respecting stop and claim backoff. */
    const tick = () => {
        if (signal.aborted || current.tick || !defaultClaimGate.ready()) return;
        current.tick = runDbJobTick(db, handlers, failureHooks, defaultClaimGate, { policies, signal })
            .catch((err) => {
                reportError(err, { tags: { component: "dbq", stage: "tick" } });
                console.error("[dbq] tick failed", err);
            }).finally(() => { current.tick = null; });
    };
    /** Track one retention sweep so shutdown can await its outstanding storage work. */
    const sweep = () => {
        if (signal.aborted || current.sweep) return;
        current.sweep = runDbJobRetentionSweep(db).catch((err) => {
            reportError(err, { tags: { component: "dbq", stage: "retention" } });
            console.error("[dbq] retention sweep failed", err);
        }).finally(() => { current.sweep = null; });
    };
    current.timers = [setInterval(tick, pollMs()), setTimeout(tick, 1_000),
        setInterval(sweep, SWEEP_EVERY_MS), setTimeout(sweep, 60_000)];
    current.timers.forEach((timer) => timer.unref());
    console.log(`[dbq] runner started (poll ${pollMs()}ms, driver ${redisEnabled() ? "redis" : "postgres"})`);
}

/** Close intake synchronously, before waiting for any other worker to drain. */
export function stopDbJobIntake(): void {
    if (!generation) return;
    generation.controller.abort();
    generation.timers.forEach(clearTimeout);
    generation.timers = [];
}

/** Stop intake and drain this generation without clearing a newer runner on restart. */
export async function stopDbJobRunner(): Promise<void> {
    const current = generation;
    stopDbJobIntake();
    if (!current) return;
    await Promise.allSettled([current.tick, current.sweep]);
    if (generation === current) generation = null;
}
