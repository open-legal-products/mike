import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { AppError } from "../appError";
import { reportError } from "../observability/sentry";
import { getRedisProducerConnection, withRedisTimeout } from "./connection";
import { redisEnabled } from "../dbq/driver";
import { enqueueDbJob } from "../dbq/enqueue";
import { createServerSupabase } from "../supabase";

/** BullMQ queue that runs DOCX/DOC → PDF conversion off the request thread. */
export const CONVERSION_QUEUE = "document-conversion";

export interface ConversionJobData {
    /** documents.id — the row whose status flips processing → ready. */
    documentId: string;
    /** document_versions.id — the row whose pdf_storage_path the worker fills. */
    versionId: string;
    /** Owner — used to derive the converted-PDF storage key. */
    userId: string;
    /** Storage key of the uploaded original (the DOCX/DOC). */
    storagePath: string;
    /** "docx" | "doc". */
    fileType: string;
    /**
     * Storage key the rendition should be written to. Version flows use a
     * per-version key (`converted-pdfs/<user>/<doc>/<slug>.pdf`) so renditions
     * of different versions never collide; when omitted the worker falls back
     * to the document-level `convertedPdfKey`.
     */
    pdfKey?: string;
    /**
     * When false, the worker only fills the version's pdf_storage_path and
     * never touches documents.status. Version add/replace/copy flows use this:
     * their document is already "ready" and a rendition failure must not
     * flip a healthy document to "error". Defaults to true (the initial-upload
     * flow, where the document is parked "processing" until conversion ends).
     */
    finalizeDocumentStatus?: boolean;
}

let queue: Queue<ConversionJobData> | null = null;
let queueConnection: IORedis | null = null;

export function getConversionQueue(): Queue<ConversionJobData> {
    // The producer connection is replaced when it wedges (see connection.ts);
    // a Queue still holding the dead client can never deliver again, so
    // compare identity on every call and rebuild on a fresh connection.
    const connection = getRedisProducerConnection();
    if (queue && queueConnection !== connection) {
        const stale = queue;
        queue = null;
        void Promise.resolve()
            .then(() => stale.close())
            .catch(() => {});
    }
    if (!queue) {
        queue = new Queue<ConversionJobData>(CONVERSION_QUEUE, { connection });
        queueConnection = connection;
    }
    return queue;
}

/**
 * Deterministic BullMQ jobId for a conversion (doubles as the DB-queue
 * dedupe key). Underscore separator, NOT ':' — BullMQ reserves ':' as its
 * Redis key separator and rejects most colon-containing custom ids
 * (everything except a legacy 3-segment form kept for old repeatable jobs,
 * which is why a colon scheme can pass one test and blow up in another).
 *
 * The id is keyed on the version AND the bytes being converted. Replace-file
 * reuses the versionId, so a version-only id makes two replaces inside the
 * conversion window collide: the second enqueue dedupes into the first job,
 * which is still carrying the FIRST upload's storage key. The queue reports
 * success, the new bytes are never converted, and the PDF the app serves is a
 * rendition of a file the user already replaced. Every upload path mints a
 * fresh storage key (a per-version random slug), so hashing it gives each
 * distinct content its own job while an honest retry of the SAME content still
 * dedupes.
 */
export function conversionJobId(
    versionId: string,
    storagePath: string,
): string {
    const token = createHash("sha256")
        .update(storagePath)
        .digest("hex")
        .slice(0, 12);
    return `convert_${versionId}_${token}`;
}

/**
 * Enqueue a conversion. Retries transient failures (storage/LibreOffice
 * hiccups) with exponential backoff.
 *
 * The jobId is derived from the version AND its storage key (see
 * conversionJobId) so a double submit of the same file is deduped by BullMQ
 * instead of racing two conversions, while a genuine re-upload gets its own
 * job. Terminal jobs are removed immediately (same rationale as the extraction
 * queue): a version can be re-converted later and a completed job record left
 * behind would silently swallow that re-enqueue as a duplicate. Durable state
 * lives in document_versions/documents, not in the job record.
 */
export async function enqueueConversion(data: ConversionJobData) {
    const dbEnqueue = () =>
        enqueueDbJob(createServerSupabase(), {
            kind: "conversion.convert",
            payload: data as unknown as Record<string, unknown>,
            dedupeKey: conversionJobId(data.versionId, data.storagePath),
            maxAttempts: 3,
        });
    // Postgres driver (no Redis anywhere): the same job rides the DB queue —
    // identical dedupe identity (the jobId doubles as the dedupe key),
    // identical retry budget, same handler body (runConversionJob).
    if (!redisEnabled()) return dbEnqueue();
    try {
        // Deadline-bounded: these enqueues sit on the upload/replace request
        // thread, and with the worker connection options a dead Redis makes
        // `add()` pend forever — the request never answers.
        return await withRedisTimeout("conversion enqueue", () =>
            getConversionQueue().add("convert", data, {
                jobId: conversionJobId(data.versionId, data.storagePath),
                attempts: 3,
                backoff: { type: "exponential", delay: 2000 },
                removeOnComplete: true,
                removeOnFail: true,
            }),
        );
    } catch (err) {
        // Fall back to the DB queue rather than rethrowing. Every caller of
        // this function `await`s it without a catch, and under Express 4 a
        // rejected async handler is an unhandled rejection whose request never
        // responds — i.e. the same hang we just fixed, wearing a different
        // hat. The DB queue runs conversion.convert with the same handler in
        // every deployment, so the work still happens; it just waits for a
        // poll tick instead of arriving instantly.
        //
        // Reported (the ioredis/BullMQ error is the cause, so its code
        // survives) and logged as the same object: a message string alone
        // reached Sentry through the console bridge with no stack and no code.
        const failure = new AppError(
            "queue.enqueue_failed",
            "[conversion] Redis enqueue failed; falling back to the DB queue",
            { cause: err },
        );
        reportError(failure, {
            level: "warning",
            tags: { job_kind: "conversion.convert" },
            extra: { document_id: data.documentId, version_id: data.versionId },
        });
        console.error(failure.message, failure);
        return dbEnqueue();
    }
}

export async function closeConversionQueue(): Promise<void> {
    if (queue) {
        await queue.close();
        queue = null;
    }
}
