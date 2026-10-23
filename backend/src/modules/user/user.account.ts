// Account / data deletion (destructive — exact call args + ordering preserved).
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.

import { deleteUserPrivateMemories } from "../../lib/memory/bulk";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
    listOrgsBlockingAccountDeletion,
    type AccountDeletionOrgBlocker,
} from "./user.dataCleanup";
import { AppError, type ErrorKind } from "../../lib/appError";
import { reportError } from "../../lib/observability/sentry";
import { type Db } from "./user.shared";

/**
 * The failure as the route's sendInternalError should report it: its kind
 * names the flow that broke, the thrown value (an Error or a PostgREST
 * object) stays the cause so its code still extracts. Nothing is logged
 * here — the route logs the same object once, with the request id.
 */
function deletionFailure(kind: ErrorKind, message: string, cause: unknown): AppError {
    return cause instanceof AppError ? cause : new AppError(kind, message, { cause });
}

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
            return {
                ok: false,
                error: deletionFailure("account.delete_failed", "request_account_deletion failed", requestError),
            };
        }
        if (!dbJobsEnabled()) {
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error)
                return {
                    ok: false,
                    error: deletionFailure("account.delete_failed", "auth user deletion failed", error),
                };
            const completed = await db.from("db_jobs").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", jobId);
            if (completed.error)
                return {
                    ok: false,
                    error: deletionFailure("account.delete_failed", "deletion job completion failed", completed.error),
                };
            return { ok: true };
        }

        // Best-effort session revocation. A failure here only means the
        // token may remain valid at the auth provider, but requireAuth already
        // denies this account using its durable deletion flag.
        if (token) {
            try {
                await db.auth.admin.signOut(token, "global");
            } catch (signOutErr) {
                // The request succeeded; the revoke that did not is a
                // warning with its own kind, logged once it is reported.
                const failure = deletionFailure(
                    "account.delete_failed",
                    "session revoke after deletion request failed",
                    signOutErr,
                );
                reportError(failure, { level: "warning" });
                console.error("[user/account] session revoke failed", {
                    userId,
                    error: failure,
                });
            }
        }
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: deletionFailure("account.delete_failed", "account deletion failed", err),
        };
    }
}

export async function deleteUserChats(
    db: Db,
    userId: string,
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserChats(db, userId, orgId);
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: deletionFailure("db.query_failed", "chat deletion failed", err),
        };
    }
}

export async function deleteUserProjectsData(
    db: Db,
    userId: string,
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserProjects(db, userId, orgId);
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: deletionFailure("db.query_failed", "project deletion failed", err),
        };
    }
}

export async function deleteUserTabularReviews(
    db: Db,
    userId: string,
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserTabularReviews(db, userId, orgId);
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: deletionFailure("db.query_failed", "tabular review deletion failed", err),
        };
    }
}

/**
 * Wipe the user's own memory for one workspace (`orgId` null is Personal)
 * and, in Personal, the memories of private projects they created.
 * Organization and merely shared projects are intentionally outside this
 * destructive action.
 */
export async function deletePrivateMemories(
    db: Db,
    userId: string,
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserPrivateMemories(db, userId, orgId);
        return { ok: true };
    } catch (err) {
        return {
            ok: false,
            error: deletionFailure("db.query_failed", "private memory deletion failed", err),
        };
    }
}
