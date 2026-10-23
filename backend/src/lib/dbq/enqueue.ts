import { AppError } from "../appError";
import { reportError } from "../observability/sentry";
import { deleteFile } from "../storage";
import { enqueueAppJobDelivery } from "../queue/appJobsQueue";
import { redisEnabled } from "./driver";
import type { Db } from "./types";

export interface EnqueueDbJobInput {
    kind: string;
    payload: Record<string, unknown>;
    /**
     * When set, at most one live (pending/running) job may exist per key —
     * enforced by the partial unique index db_jobs_dedupe_live_idx, so the
     * check is race-free across replicas. A deduped enqueue is a success
     * from the caller's point of view (the work is already scheduled).
     */
    dedupeKey?: string;
    maxAttempts?: number;
    /** Delay the first run (ISO timestamp). Defaults to now. */
    runAt?: string;
}

export type EnqueueDbJobResult =
    | { id: string; deduped: false }
    | { id: string | null; deduped: true };

/** Postgres unique_violation — the dedupe index rejected a second live job. */
const UNIQUE_VIOLATION = "23505";

/**
 * A Redis delivery that failed after the durable row was written. The poll
 * backstop still runs the job, so this is a warning; but a Redis that keeps
 * refusing deliveries is how "instant" becomes "a minute later" in every
 * deployment that paid for Redis, so it is reported (with the ioredis code
 * on the cause chain) and logged as the same object, not swallowed.
 */
function reportDeliveryFailure(
    label: string,
    jobKind: string,
    error: unknown,
): void {
    const failure = new AppError(
        "queue.enqueue_failed",
        `[dbq] ${label}; poll backstop will run the job`,
        { cause: error },
    );
    reportError(failure, {
        level: "warning",
        tags: { component: "dbq", stage: "delivery", job_kind: jobKind },
    });
    console.error(failure.message, failure);
}

/**
 * Enqueue one durable background job. Throws on real failures (callers that
 * must not fail their request on enqueue errors wrap this themselves and
 * fall back to doing the work inline).
 */
export async function enqueueDbJob(
    db: Db,
    input: EnqueueDbJobInput,
): Promise<EnqueueDbJobResult> {
    const { data, error } = await db
        .from("db_jobs")
        .insert({
            kind: input.kind,
            payload: input.payload,
            dedupe_key: input.dedupeKey ?? null,
            ...(input.maxAttempts != null
                ? { max_attempts: input.maxAttempts }
                : {}),
            ...(input.runAt ? { run_at: input.runAt } : {}),
        })
        .select("id")
        .single();

    if (error) {
        if (error.code === UNIQUE_VIOLATION && input.dedupeKey) {
            // Someone else already queued this work. Surface the live job's
            // id when we can find it (pollers want it); dedupe stays a
            // success either way.
            const { data: existing } = await db
                .from("db_jobs")
                .select("id")
                .eq("dedupe_key", input.dedupeKey)
                .in("status", ["pending", "running"])
                .limit(1)
                .maybeSingle();
            return { id: (existing?.id as string) ?? null, deduped: true };
        }
        // The PostgREST error is the cause: its code (SQLSTATE / PGRST*)
        // reaches failure_code, and the kind names the failure.
        throw new AppError(
            "dbq.enqueue_failed",
            `[dbq] enqueue ${input.kind} failed: ${error.message}`,
            { cause: error },
        );
    }

    // Outbox delivery: the row above is the durable record; when Redis is
    // configured, also hand its id to BullMQ so a worker picks it up in
    // milliseconds instead of at the next poll. Best-effort by design — a
    // failed delivery just means the poll backstop runs the job instead.
    if (redisEnabled()) {
        try {
            const delayMs = input.runAt
                ? new Date(input.runAt).getTime() - Date.now()
                : 0;
            await enqueueAppJobDelivery(data.id as string, { delayMs });
        } catch (err) {
            reportDeliveryFailure("redis delivery failed", input.kind, err);
        }
    }
    return { id: data.id as string, deduped: false };
}

/**
 * Liveness probe by dedupe key: does a pending/running job exist? The
 * stale-work reaper uses this in Postgres-driver mode exactly like it uses
 * Queue#getJob in Redis mode — job existence is the ownership signal for a
 * transient domain status.
 */
export async function liveDbJobExists(
    db: Db,
    dedupeKey: string,
): Promise<boolean> {
    const { data } = await db
        .from("db_jobs")
        .select("id")
        .eq("dedupe_key", dedupeKey)
        .in("status", ["pending", "running"])
        .limit(1)
        .maybeSingle();
    return !!data;
}

/**
 * The batched form of liveDbJobExists: which of these dedupe keys still have
 * a pending or running job. One indexed query however many keys are asked
 * about, for readers that judge a page of domain rows at once.
 */
export async function liveDbJobDedupeKeys(
    db: Db,
    dedupeKeys: readonly string[],
): Promise<Set<string>> {
    if (dedupeKeys.length === 0) return new Set();
    const { data, error } = await db
        .from("db_jobs")
        .select("dedupe_key")
        .in("dedupe_key", [...dedupeKeys])
        .in("status", ["pending", "running"]);
    if (error) throw error;
    return new Set(
        ((data ?? []) as { dedupe_key: string | null }[]).flatMap((row) =>
            row.dedupe_key ? [row.dedupe_key] : [],
        ),
    );
}

/**
 * Ask BullMQ to pick up cleanup rows the document_versions trigger inserted.
 *
 * Those rows are written by a database trigger inside the deleting
 * transaction, so no application code holds their ids to deliver them the way
 * enqueueDbJob does for the rows it inserts itself. Without this the only
 * collector is the poller — which idles at 60s precisely because Redis
 * deployments expect delivery to be instant — and a bulk delete's bytes stay
 * live for hours.
 *
 * Delivering a handful is enough: handleDocumentCleanup coalesces the rest of
 * the backlog into the run this triggers. Claims are idempotent (a duplicate
 * delivery matches zero rows), so over-delivering is harmless, and the whole
 * thing is best-effort: a failure just means the poll backstop runs them.
 */
export async function requestDocumentCleanupDelivery(
    db: Db,
    limit = 5,
): Promise<number> {
    if (process.env.DB_JOBS_ENABLED === "false") return 0;
    if (!redisEnabled()) return 0;
    try {
        const { data, error } = await db
            .from("db_jobs")
            .select("id")
            .eq("kind", "document.cleanup")
            .eq("status", "pending")
            .limit(limit);
        if (error) throw error;
        const ids = (data ?? []).map((row) => row.id as string);
        await Promise.all(ids.map((id) => enqueueAppJobDelivery(id)));
        return ids.length;
    } catch (err) {
        reportDeliveryFailure(
            "document.cleanup delivery failed",
            "document.cleanup",
            err,
        );
        return 0;
    }
}

/**
 * Durably delete storage objects: enqueue a storage.cleanup job, falling
 * back to today's best-effort inline deletes if the enqueue itself fails.
 * Never throws — callers use this on paths where cleanup must not fail the
 * user's request (the DB rows are already deleted by the time this runs).
 */
export async function enqueueStorageCleanup(
    db: Db,
    keys: string[],
    prefixes: string[] = [],
): Promise<void> {
    if (keys.length === 0 && prefixes.length === 0) return;
    try {
        await enqueueDbJob(db, {
            kind: "storage.cleanup",
            payload: { keys, prefixes },
            maxAttempts: 8,
        });
    } catch (err) {
        // The durable record could not be written, so the inline deletes
        // below are the only attempt these objects will ever get. That is a
        // real degradation, reported as such; the enqueue error (already a
        // dbq.enqueue_failed AppError with the PostgREST code) is the cause,
        // and the same object is logged so the bridge files no duplicate.
        const failure =
            err instanceof AppError
                ? err
                : new AppError(
                      "dbq.enqueue_failed",
                      "[dbq] storage.cleanup enqueue failed",
                      { cause: err },
                  );
        reportError(failure, {
            tags: { component: "dbq", job_kind: "storage.cleanup" },
            extra: { keys: keys.length, prefixes: prefixes.length },
        });
        console.error(
            "[dbq] storage.cleanup enqueue failed; falling back to inline deletes",
            failure,
        );
        for (const key of keys) {
            try {
                await deleteFile(key);
            } catch {
                // Best-effort by definition here.
            }
        }
    }
}
