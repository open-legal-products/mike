// conversionJobs — implementation behind the module facade.
import { runConversionJob, setDocumentTerminalStatus } from "./documents.conversion";
import { type ConversionJobData } from "../../lib/queue/conversionQueue";
import { type Db, type DbJob } from "../../lib/dbq/types";

// Postgres-driver fallback for the two BullMQ-native workloads: the SAME
// job bodies (runConversionJob / runExtractionJob) run off db_jobs rows when
// no Redis is configured. Their retry budget and dedupe identity match the
// BullMQ path (set at enqueue time in lib/queue/*Queue.ts), and their
// domain-level permanent-failure semantics are reproduced by the failure
// hooks below — the generic state machine only knows about db_jobs rows.

export async function handleConversionConvert(
    db: Db,
    job: DbJob,
): Promise<void> {
    await runConversionJob(job.payload as unknown as ConversionJobData, db);
}

export async function markConversionFailed(db: Db, job: DbJob): Promise<void> {
 const data = job.payload as unknown as ConversionJobData;
 if (data.finalizeDocumentStatus === false) return;
 await setDocumentTerminalStatus(db, data.documentId, "error");
}
