import { createServerSupabase, type Db } from "../lib/supabase";
import { safeError } from "../lib/safeError";
import { logError } from "../lib/log";
import { backfillDocumentText, sweepStaleProcessingDocuments } from "../modules/documents/documents.service";
import { sweepStaleGeneratingCells } from "../modules/tabular/tabular.service";
import { expireDepartureArchives, purgeExpiredOrganizations } from "../modules/orgs/orgs.service";

/** Run recovery/expiry sweeps; errors are contained per sweep. */
export async function runStaleWorkSweep(
    db: Db = createServerSupabase(),
): Promise<{ documents: number; cells: number }> {
    await backfillDocumentText(db).catch((err) => {
        logError("stale-sweep", safeError(err), { sweep: "document-text" });
    });
    const documents = await sweepStaleProcessingDocuments(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "documents" });
        return 0;
    });
    const cells = await sweepStaleGeneratingCells(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "cells" });
        return 0;
    });
    await expireDepartureArchives(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "organization-archives" });
    });
    await purgeExpiredOrganizations(db).catch((err) => {
        logError("stale-sweep", err, { sweep: "organizations" });
    });
    return { documents, cells };
}
