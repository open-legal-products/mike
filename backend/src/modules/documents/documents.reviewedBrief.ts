import type { Db } from "../../lib/supabase";
import { processDocumentTextInline } from "./documents.indexing";
import { logError } from "../../lib/log";
import { safeError } from "../../lib/safeError";
/** The only brief-specific document lifecycle writer. SQL owns the CAS and
 * commits the new version, reviewed fingerprints and proposal completion. */
export async function applyReviewedBrief(db: Db, input: {
    projectId: string;
    userId: string;
    userEmail?: string;
    proposalId: string;
}) {
    const result = await db.rpc("project_brief_apply", {
        p_project_id: input.projectId, p_actor_id: input.userId,
        p_actor_email: input.userEmail ?? "", p_proposal_id: input.proposalId,
    });
    if (!result.error && result.data?.versionId && !result.data.replayed) {
        await processDocumentTextInline(db, [result.data.versionId])
            .catch(error => logError("document-text", safeError(error)));
    }
    return result;
}
