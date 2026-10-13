import { performance } from "node:perf_hooks";
import type { ClaimIdentity } from "./claim";
import type { Db, DbJob, DbJobHandler, DbJobExecutionContext, DbJobExecutionPolicy, DbJobExecutionPolicies } from "./types";

export const CLAIM_STALE_SECONDS = 600;
const REQUEST_TIMEOUT_MS = 10_000;
type LostReason = "ownership_lost" | "renewal_unknown" | "deadline" | "shutdown";
export type ExecutionOutcome =
    | { kind: "completed"; result: Record<string, unknown> | void }
    | { kind: "failed"; error: unknown }
    | { kind: "closed"; reason: LostReason };

/** Reject renewal intervals and execution budgets outside the supported timer bounds. */
function assertValidExecutionPolicy(policy: DbJobExecutionPolicy): void {
    if (!Number.isFinite(policy.heartbeatIntervalMs) || policy.heartbeatIntervalMs <= 0 ||
        policy.heartbeatIntervalMs > CLAIM_STALE_SECONDS * 1000 / 3 ||
        !Number.isFinite(policy.maxDurationMs) || policy.maxDurationMs <= 0 ||
        policy.maxDurationMs > 2_147_483_647)
        throw new Error("invalid_db_job_execution_policy");
}

/** Reject configuration before intake can consume a durable attempt. */
export function assertValidExecutionPolicies(policies: DbJobExecutionPolicies): void {
    for (const [kind, policy] of Object.entries(policies)) {
        if (kind === "storage.cleanup" || kind === "document.cleanup")
            throw new Error("cleanup_claim_renewal_not_supported");
        assertValidExecutionPolicy(policy);
    }
}

/** A cooperative execution lease, not a sandbox or an external-effect fence. */
export async function executeWithClaim(
    db: Db,
    job: DbJob,
    claim: Readonly<ClaimIdentity>,
    handler: DbJobHandler,
    policy: DbJobExecutionPolicy,
    parentSignal?: AbortSignal,
): Promise<ExecutionOutcome> {
    assertValidExecutionPolicy(policy);

    const owner = new AbortController();
    const expires = performance.now() + policy.maxDurationMs;
    let reason: LostReason | undefined;
    let finishing = false;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let inFlight: Promise<boolean> | undefined;
    let resolveClosed!: (outcome: ExecutionOutcome) => void;
    const closed = new Promise<ExecutionOutcome>((resolve) => { resolveClosed = resolve; });

    /** Irreversibly abort local work and renewal without releasing the database claim. */
    const close = (why: LostReason) => {
        if (reason) return;
        reason = why;
        if (heartbeat) clearTimeout(heartbeat);
        owner.abort();
        request?.abort();
        resolveClosed({ kind: "closed", reason: why });
    };
    /** Recheck monotonic deadline and shutdown even when event-loop timers ran late. */
    const current = () => {
        if (!reason && performance.now() >= expires) close("deadline");
        if (!reason && parentSignal?.aborted) close("shutdown");
        return !reason;
    };
    /** Close this execution when its owning worker generation stops intake. */
    const onShutdown = () => close("shutdown");
    parentSignal?.addEventListener("abort", onShutdown, { once: true });

    // assertOwnership and scheduled renewals share the same request. Even an
    // abort-ignoring transport is bounded locally; a late response cannot reopen
    // the controller. An uncertain heartbeat is left to expire in PostgreSQL.
    /** Share one bounded heartbeat RPC; uncertainty closes the execution permanently. */
    const renew = (): Promise<boolean> => {
        if (finishing || !current()) return Promise.resolve(false);
        if (inFlight) return inFlight;
        inFlight = (async () => {
            if (!claim.claimedAt) { close("ownership_lost"); return false; }
            const active = new AbortController();
            request = active;
            let timeout: ReturnType<typeof setTimeout> | undefined;
            let onAbort!: () => void;
            try {
                const interrupted = new Promise<never>((_resolve, reject) => {
                    onAbort = () => reject(new Error("claim_request_aborted"));
                    active.signal.addEventListener("abort", onAbort, { once: true });
                    timeout = setTimeout(() => active.abort(), REQUEST_TIMEOUT_MS);
                    timeout.unref();
                });
                const query = Promise.resolve().then(() => db.rpc("heartbeat_db_job", {
                    p_id: claim.id, p_attempts: claim.attempts, p_claimed_at: claim.claimedAt,
                }).abortSignal(active.signal));
                const { data, error } = await Promise.race([Promise.resolve(query), interrupted]);
                if (!current()) return false;
                if (error) { close("renewal_unknown"); return false; }
                if (!Array.isArray(data) || data.length > 1 ||
                    (data.length === 1 && (data[0].id !== claim.id ||
                        !Number.isFinite(Date.parse(data[0].heartbeat_at))))) {
                    close("renewal_unknown"); return false;
                }
                if (!data.length) { close("ownership_lost"); return false; }
                return true;
            } catch {
                if (!reason) close("renewal_unknown");
                return false;
            } finally {
                if (timeout) clearTimeout(timeout);
                if (onAbort) active.signal.removeEventListener("abort", onAbort);
                if (request === active) request = undefined;
            }
        })().finally(() => { inFlight = undefined; });
        return inFlight;
    };
    /** Schedule the next heartbeat only after the preceding request has completed. */
    const schedule = () => {
        if (finishing || !current()) return;
        heartbeat = setTimeout(() => {
            void renew().then((valid) => { if (valid) schedule(); });
        }, policy.heartbeatIntervalMs);
        heartbeat.unref();
    };
    const context: DbJobExecutionContext = Object.freeze({
        claim,
        signal: owner.signal,
        deadlineAt: Date.now() + policy.maxDurationMs,
        remainingMs: () => Math.max(0, expires - performance.now()),
        assertOwnership: async () => {
            if (!(await renew()) || !current()) throw new Error("db_job_ownership_lost");
        },
    });
    deadline = setTimeout(() => close("deadline"), policy.maxDurationMs);
    deadline.unref();
    try {
        if (!(await renew())) return { kind: "closed", reason: reason ?? "ownership_lost" };
        schedule();
        const body: Promise<ExecutionOutcome> = Promise.resolve().then(async () => {
            if (!current()) return { kind: "closed", reason: reason! };
            try { return { kind: "completed", result: await handler(db, job, context) }; }
            catch (error) { return { kind: "failed", error }; }
        });
        // Both body branches resolve, including a rejection after this race
        // already closed. No unhandled late promise can escape.
        const outcome = await Promise.race([body, closed]);
        finishing = true;
        if (heartbeat) clearTimeout(heartbeat);
        if (inFlight) await inFlight;
        return current() ? outcome : { kind: "closed", reason: reason! };
    } finally {
        finishing = true;
        if (heartbeat) clearTimeout(heartbeat);
        if (deadline) clearTimeout(deadline);
        parentSignal?.removeEventListener("abort", onShutdown);
        request?.abort();
        owner.abort();
    }
}
