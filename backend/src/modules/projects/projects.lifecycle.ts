import { chunkArray } from "../../lib/arrays";
import type { Db } from "../../lib/supabase";
import { uniqueStrings, throwIfError } from "../../lib/serviceData";
import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "../documents/documents.service";
/**
 * Delete projects (and everything inside them) by id, with no ownership
 * filter. Callers must have authorised the delete themselves — routes do that
 * through the `container.delete` capability, and an organization project may
 * have no creator left to scope by anyway.
 */
export async function deleteProjectsByIds(db: Db, projectIds: string[]) {
    const ownedProjectIds = uniqueStrings(projectIds);
    if (ownedProjectIds.length === 0)
        return 0;
    const keys = await captureInlineDocumentCleanup(db, { projectIds: ownedProjectIds });
    // Parent DELETE owns the relational cascades and all durable cleanup.
    for (const ids of chunkArray(ownedProjectIds, 500)) {
        const { error } = await db.from("projects").delete().in("id", ids);
        await throwIfError(error, "Failed to delete projects");
    }
    await completeInlineDocumentCleanup(db, keys);
    return ownedProjectIds.length;
}
