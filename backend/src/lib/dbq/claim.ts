import type { Db, DbJob } from "./types";

/** Immutable attempt identity. A null claimedAt never authorizes settlement. */
export type ClaimIdentity = {
    id: string;
    attempts: number;
    claimedAt: string | null;
};

export type Settlement =
    | { kind: "committed" }
    | { kind: "ownership_lost" }
    | { kind: "outcome_unknown"; error: unknown };

export type SettlementPatch = {
    status: "done" | "pending" | "failed";
    finished_at?: string | null;
    last_error: string | null;
    result?: DbJob["result"];
    run_at?: string;
    attempts?: number;
    max_attempts?: number;
};

/** Copy the attempt fence before a handler can mutate its job object. */
export function claimIdentity(
    job: Pick<DbJob, "id" | "attempts" | "claimed_at">,
): ClaimIdentity {
    return { id: job.id, attempts: job.attempts, claimedAt: job.claimed_at };
}

/** Contain transport exceptions: an uncertain write must never become a retry. */
export async function settleClaim(
    db: Db,
    claim: ClaimIdentity,
    patch: SettlementPatch,
    requireLiveLease = false,
): Promise<Settlement> {
    if (!claim.claimedAt) return { kind: "ownership_lost" };
    try {
        const query = requireLiveLease
            ? db.rpc("settle_live_db_job", {
                p_id: claim.id, p_attempts: claim.attempts, p_claimed_at: claim.claimedAt,
                p_outcome: patch.status, p_result: patch.result ?? null,
                p_last_error: patch.last_error, p_run_at: patch.run_at ?? null,
                p_refund_attempt: patch.attempts === claim.attempts - 1,
            })
            : db.from("db_jobs").update(patch)
            .eq("id", claim.id)
            .eq("status", "running")
            .eq("attempts", claim.attempts)
            .eq("claimed_at", claim.claimedAt)
            .select("id");
        const { data, error } = await query;
        if (error) return { kind: "outcome_unknown", error };
        if (Array.isArray(data) && data.length === 1 && data[0].id === claim.id)
            return { kind: "committed" };
        if (Array.isArray(data) && data.length === 0)
            return { kind: "ownership_lost" };
        return { kind: "outcome_unknown", error: new Error("invalid_settlement_response") };
    } catch (error) {
        return { kind: "outcome_unknown", error };
    }
}
