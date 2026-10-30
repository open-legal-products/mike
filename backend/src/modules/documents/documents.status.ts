import type { Db } from "../../lib/supabase";
import { chunkArray } from "../../lib/arrays";
import { mapWithConcurrency } from "../../lib/concurrency";
import { createDocumentAccessChecker } from "../../lib/access";
import { attachActiveVersionPaths, attachLatestVersionNumbers } from "../../lib/documentVersions";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { canManageDocument } from "./documents.access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A polling batch discloses only readable, active documents, just like detail. */
export async function getDocumentStatuses(db: Db, args: {
    documentIds: unknown; userId: string; userEmail?: string;
}): Promise<ServiceResult<Record<string, unknown>[]>> {
    if (!Array.isArray(args.documentIds) || args.documentIds.length > 100
        || args.documentIds.some(id => typeof id !== "string" || !UUID.test(id))) {
        return failure("validation", "Supply at most 100 document IDs.");
    }
    const check = createDocumentAccessChecker(args.userId, args.userEmail, db);
    const result: Record<string, unknown>[] = [];
    try {
        for (const ids of chunkArray([...new Set(args.documentIds as string[])], 50)) {
            const { data, error } = await db.from("documents").select("*").in("id", ids).is("archived_at", null);
            if (error) return internalFailure(error);
            type Row = Parameters<typeof check>[0] & { id: string; current_version_id?: string | null };
            const rows = (data ?? []) as Row[];
            const verdicts = await mapWithConcurrency(rows, 5, check);
            const visible = rows.flatMap((doc, i) => {
                const access = verdicts[i];
                if (!access.ok) return [];
                const editable = canManageDocument(access, doc);
                return [{ ...doc, can_edit: editable, can_delete: editable }];
            });
            await attachLatestVersionNumbers(db, visible);
            await attachActiveVersionPaths(db, visible);
            result.push(...visible);
        }
        return ok(result);
    } catch (error) { return internalFailure(error); }
}
