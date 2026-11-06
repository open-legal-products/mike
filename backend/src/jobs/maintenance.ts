import { createServerSupabase, type Db } from "../lib/supabase";
import { safeError } from "../lib/safeError";
import { withKind } from "../lib/appError";
import { reportSchemaOutOfDateOnce } from "../lib/schemaOutOfDate";
import { runIsolated } from "../lib/dbq/jobScope";
import { reportError, setOperation } from "../lib/observability/sentry";
import type { Operation } from "../lib/observability/sentryPrivacy";
import { backfillDocumentText, sweepStaleProcessingDocuments } from "../modules/documents/documents.service";
import { sweepStaleGeneratingCells } from "../modules/tabular/tabular.service";
import { expireDepartureArchives, purgeExpiredOrganizations } from "../modules/orgs/orgs.service";
import { purgeExpiredSubagentRuns } from "../modules/chat/chat.service";

/** Isolate timer-driven work just as the queue runner isolates each job. */
function runSweep<T>(operation: Operation, work: () => Promise<T>): Promise<T | undefined> {
    return runIsolated(async () => {
        setOperation(operation);
        try {
            return await work();
        } catch (cause) {
            // A database behind this build fails the same way on every sweep
            // until someone migrates it: one error-level event per operation
            // per process, then an hourly log reminder, not one event per
            // run. The other sweeps still run.
            if (reportSchemaOutOfDateOnce(cause, { key: operation, tags: { component: "stale-sweep" } })) {
                return undefined;
            }
            reportError(withKind(cause, "maintenance.sweep_failed", "Maintenance sweep failed"), {
                tags: { component: "stale-sweep" },
            });
            // Keep a content-free local notice without the error-console bridge
            // filing a second event for an already reported failure.
            console.warn("[stale-sweep] failed", { operation, ...safeError(cause) });
            return undefined;
        }
    });
}

/** Run recovery/expiry sweeps; errors are contained per sweep. */
export async function runStaleWorkSweep(
    db: Db = createServerSupabase(),
): Promise<{ documents: number; cells: number }> {
    await runSweep("maintenance.document_text", () => backfillDocumentText(db));
    const documents = await runSweep("maintenance.documents", () => sweepStaleProcessingDocuments(db));
    const cells = await runSweep("maintenance.cells", () => sweepStaleGeneratingCells(db));
    await runSweep("maintenance.organization_archives", () => expireDepartureArchives(db));
    await runSweep("maintenance.organizations", () => purgeExpiredOrganizations(db));
    await runSweep("maintenance.subagent_runs", () => purgeExpiredSubagentRuns(db));
    return { documents: documents ?? 0, cells: cells ?? 0 };
}
