import { deleteUserPrivateMemories } from "../../lib/memory/bulk";
import { deleteAllUserChats, deleteAllUserTabularReviews, deleteUserProjects } from "./dataCleanup";
import type { Db } from "../../lib/supabase";
import { withKind, type ErrorKind } from "../../lib/appError";

/**
 * The failure as the route's sendInternalError should report it: its kind
 * names the flow that broke, the thrown value (an Error or a PostgREST
 * object) stays the cause so its code still extracts. Nothing is logged
 * here — the route logs the same object once, with the request id.
 */
function deletionFailure(kind: ErrorKind, message: string, cause: unknown): Error {
    return withKind(cause, kind, message);
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
