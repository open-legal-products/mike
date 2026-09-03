import type { Db } from "../supabase";
export type { Db };

/** One row of public.db_jobs (see the 20260829_01_db_jobs migration). */
export interface DbJob {
    id: string;
    kind: string;
    payload: Record<string, unknown>;
    status: "pending" | "running" | "done" | "failed";
    attempts: number;
    max_attempts: number;
    run_at: string;
    claimed_at: string | null;
    finished_at: string | null;
    last_error: string | null;
    dedupe_key: string | null;
    result: Record<string, unknown> | null;
    created_at: string;
}

/**
 * A job handler. Runs with at-least-once semantics: it MUST be idempotent
 * (a crash after partial work re-runs the whole job) and it signals a
 * retryable failure by THROWING — returning normally marks the job done.
 * The optional return value is persisted into db_jobs.result for pollers.
 */
export type DbJobHandler = (
    db: Db,
    job: DbJob,
) => Promise<Record<string, unknown> | void>;

export type DbJobHandlers = Record<string, DbJobHandler>;
