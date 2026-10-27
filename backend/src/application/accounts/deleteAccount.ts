// Account / data deletion (destructive — exact call args + ordering preserved).
//
// Application service invoked by the user HTTP entrypoint. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    deleteUserAccountData,
    listOrgsBlockingAccountDeletion,
    type AccountDeletionOrgBlocker,
} from "./dataCleanup";
import { type Db, errorMessage } from "../../lib/serviceData";
/** Explain which organizations need an owner before account deletion. */
export function describeAccountDeletionBlockers(
    blockers: AccountDeletionOrgBlocker[],
): string {
    const named = (reason: AccountDeletionOrgBlocker["reason"]) =>
        blockers
            .filter((blocker) => blocker.reason === reason)
            .map((blocker) => blocker.name)
            .join(", ");
    const sentences: string[] = [];
    const withMembers = named("members");
    if (withMembers)
        sentences.push(
            `You are the only owner of ${withMembers}. Make another member an owner, or delete the organization, before deleting your account.`,
        );
    const withContent = named("content");
    if (withContent)
        sentences.push(
            `You are the only owner of ${withContent}, and must appoint another owner or explicitly delete the organization before deleting your account.`,
        );
    return sentences.join(" ");
}
export async function deleteUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    token: string | undefined,
): Promise<
    | { ok: true }
    | {
          ok: false;
          kind: "org_successor_required";
          blockers: AccountDeletionOrgBlocker[];
          error?: undefined;
      }
    | { ok: false; kind?: undefined; error: unknown }
> {
    try {
        // ORGANIZATIONS FIRST. An account that is the only owner of an
        // team organization cannot be deleted, even when it is empty:
        // promoting an arbitrary successor hands a firm's matters to whoever
        // joined first (and silently clears their `deny` overrides), while
        // removing the member outright is refused by the last-owner guard
        // (org_members_protect_last_owner), and would otherwise leave the
        // organization memberless, invisible and undeletable. Answer 409 and let the user
        // choose a successor. This check runs BEFORE the enqueue so nothing
        // is scheduled, revoked, or destroyed.
        const blockers = await listOrgsBlockingAccountDeletion(db, userId);
        if (blockers.length > 0)
            return { ok: false, kind: "org_successor_required", blockers };

        // Queue insertion, organization handover, membership removal and the
        // authentication fence commit together. No accepted request leaves a
        // usable account waiting for a background worker.
        const { data: jobId, error: requestError } = await db.rpc("request_account_deletion", {
            p_user_id: userId,
            p_user_email: userEmail ?? null,
        });
        if (requestError) {
            if (requestError.code === "23514") {
                const currentBlockers = await listOrgsBlockingAccountDeletion(db, userId);
                if (currentBlockers.length) return { ok: false, kind: "org_successor_required", blockers: currentBlockers };
            }
            return { ok: false, error: requestError };
        }
        if (!dbJobsEnabled()) {
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error) return { ok: false, error };
            const completed = await db.from("db_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", jobId);
            if (completed.error) return { ok: false, error: completed.error };
            return { ok: true };
        }

        // Best-effort session revocation. A failure here only means the
        // token may remain valid at the auth provider, but requireAuth already
        // denies this account using its durable deletion flag.
        if (token) {
            try {
                await db.auth.admin.signOut(token, "global");
            } catch (signOutErr) {
                console.error("[user/account] session revoke failed", {
                    userId,
                    error: errorMessage(signOutErr),
                });
            }
        }
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/account] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}
