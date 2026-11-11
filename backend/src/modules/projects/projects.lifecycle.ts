import type { Db } from "../../lib/supabase";
import { mutateInBatches, uniqueIds } from "../../lib/batchedQuery";
import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "../documents/documents.service";
/**
 * Delete projects (and everything inside them) by id, with no ownership
 * filter. Callers must have authorised the delete themselves — routes do that
 * through the `container.delete` capability, and an organization project may
 * have no creator left to scope by anyway.
 */
export async function deleteProjectsByIds(db: Db, projectIds: string[]) {
    const ownedProjectIds = uniqueIds(projectIds);
    if (ownedProjectIds.length === 0)
        return 0;
    const keys = await captureInlineDocumentCleanup(db, { projectIds: ownedProjectIds });
    // Parent DELETE owns the relational cascades and all durable cleanup.
    // The id list travels in the request URL, so it goes out in the shared
    // URL-safe batch size: 500 UUIDs is past what the gateway accepts.
    await mutateInBatches("project delete", ownedProjectIds, (ids) =>
        db.from("projects").delete().in("id", ids));
    await completeInlineDocumentCleanup(db, keys);
    return ownedProjectIds.length;
}
