import { createServerSupabase, type Db } from "../lib/supabase";
import { logError } from "../lib/log";
import { sweepStaleProcessingDocuments } from "../modules/documents/documents.service";
import { sweepStaleGeneratingCells } from "../modules/tabular/tabular.service";
import { expireDepartureArchives, purgeExpiredOrganizations } from "../modules/orgs/orgs.service";

/** Run recovery/expiry sweeps; errors are contained per sweep. */
export async function runStaleWorkSweep(
    db: Db = createServerSupabase(),
): Promise<{ documents: number; cells: number }> {
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
