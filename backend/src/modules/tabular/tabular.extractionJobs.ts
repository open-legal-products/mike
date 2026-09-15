// extractionJobs — implementation behind the module facade.
import { runExtractionJob, markExtractionFailed } from "./tabular.extraction";
import { publishCellUpdate } from "../../lib/queue/runProgress";
import { type ExtractionJobData } from "../../lib/queue/extractionQueue";
import { type Db, type DbJob } from "../../lib/dbq/types";

export async function handleExtractionExtract(
    db: Db,
    job: DbJob,
): Promise<void> {
    // publishCellUpdate no-ops without Redis; the SSE views' DB-poll
    // backstops carry progress in this mode.
    await runExtractionJob(job.payload as unknown as ExtractionJobData, {
        db,
        publish: publishCellUpdate,
    });
}

export async function markExtractionJobFailed(db: Db, job: DbJob): Promise<void> {
 await markExtractionFailed(job.payload as unknown as ExtractionJobData, { db, publish: publishCellUpdate });
}
