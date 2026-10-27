import { deleteUserPrivateMemories } from "../../lib/memory/bulk";
import { deleteAllUserChats, deleteAllUserTabularReviews, deleteUserProjects } from "./dataCleanup";
import { type Db, errorMessage } from "../../lib/serviceData";
export async function deleteUserChats(
    db: Db,
    userId: string,
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserChats(db, userId, orgId);
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
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteUserProjects(db, userId, orgId);
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
    orgId: string | null,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
    try {
        await deleteAllUserTabularReviews(db, userId, orgId);
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
        console.error("[user/memories] delete failed", {
            userId,
            error: errorMessage(err),
        });
        return { ok: false, error: err };
    }
}
