// Account / data deletion (destructive — exact call args + ordering preserved).
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract. The userDataCleanup helpers + auth-admin deleteUser call are
// invoked with identical args and ordering.

import { enqueueDbJob } from "../../lib/dbq/enqueue";
import { dbJobsEnabled } from "../../lib/dbq/runner";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserAccountData,
    deleteUserProjects,
} from "../../lib/userDataCleanup";
import { type Db, errorMessage } from "./user.shared";

export async function deleteUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
    token: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        // DATA FIRST, AUTH LAST — main's ordering, kept.
        //
        // documents.user_id references auth.users ON DELETE CASCADE (and
        // document_versions cascades from documents), so deleting the auth
        // user first destroys every row that records where this account's
        // files live. The cascade would then find nothing to clean up and
        // the objects would be orphaned in storage forever. The auth user
        // is therefore deleted by the job, as its final step, once the
        // data is actually gone.
        //
        // What the user experiences is unchanged: their sessions are
        // revoked here, immediately, so the account is unusable from the
        // moment this returns. The auth row lingering for the length of
        // the job is what makes the job's retries meaningful — a cascade
        // that permanently fails leaves a recoverable account instead of
        // an anonymous pile of rows.
        //
        // No runner on this process? Then a 202-style "it's queued" would
        // be a promise nothing can keep, so run the cascade inline —
        // exactly main's behaviour, which is still correct, just not
        // crash-durable.
        if (!dbJobsEnabled()) {
            console.warn(
                "[user/account] DB job runner disabled; deleting inline",
                { userId },
            );
            await deleteUserAccountData(db, userId, userEmail);
            const { error } = await db.auth.admin.deleteUser(userId);
            if (error) return { ok: false, error };
            return { ok: true };
        }

        // Enqueue BEFORE anything is destroyed: if this fails, nothing has
        // happened and the request is cleanly retriable.
        await enqueueDbJob(db, {
            kind: "account.delete",
            payload: { userId, userEmail: userEmail ?? null },
            dedupeKey: `account.delete:${userId}`,
            maxAttempts: 20,
        });

        // Best-effort session revocation. A failure here only means the
        // user keeps a valid token until the job deletes their auth user;
        // it must not fail a deletion that is already durably scheduled.
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

export async function deleteUserChats(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserChats(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/chats] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserProjectsData(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserProjects(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/projects] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function deleteUserTabularReviews(
    db: Db,
    userId: string,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserTabularReviews(db, userId);
        return { ok: true };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/tabular-reviews] delete failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}
