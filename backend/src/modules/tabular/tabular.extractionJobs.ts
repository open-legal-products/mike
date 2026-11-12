// extractionJobs — implementation behind the module facade.
import { runExtractionJob, markExtractionFailed } from "./tabular.extraction";
import { publishCellUpdate } from "../../lib/queue/runProgress";
import { type ExtractionJobData } from "../../lib/queue/extractionQueue";
import { type Db, type DbJob } from "../../lib/dbq/types";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import { ExtractionParseError } from "../../lib/extraction/failure";
import { ExtractionLimitError } from "../../lib/extraction/limits";

export async function handleExtractionExtract(
    db: Db,
    job: DbJob,
): Promise<void> {
    // publishCellUpdate no-ops without Redis; the SSE views' DB-poll
    // backstops carry progress in this mode.
    try {
        await runExtractionJob(job.payload as unknown as ExtractionJobData, {
            db,
            publish: publishCellUpdate,
        });
    } catch (error) {
        // The same terminal verdicts as the Redis transport
        // (workers/extraction.transport.ts): a source document that cannot be
        // parsed, or is over the extraction limits, fails identically on
        // every attempt. Retrying only keeps the cell "generating" until the
        // attempts run out.
        if (error instanceof ExtractionParseError) {
            throw new NonRetryableJobError("document_text_unreadable", {
                cause: error,
                reportLevel: "warning",
            });
        }
        if (error instanceof ExtractionLimitError) {
            throw new NonRetryableJobError("document_too_large", { cause: error });
        }
        throw error;
    }
}

export async function markExtractionJobFailed(db: Db, job: DbJob): Promise<void> {
 await markExtractionFailed(job.payload as unknown as ExtractionJobData, { db, publish: publishCellUpdate });
}
