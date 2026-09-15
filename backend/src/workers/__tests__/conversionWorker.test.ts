import { describe, it, expect, vi, beforeEach } from "vitest";

// Never construct a real Supabase client during the unit test.
vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(),
}));

const enqueueDbJob = vi.fn();
vi.mock("../../lib/dbq/enqueue", () => ({
    enqueueDbJob: (...a: unknown[]) => enqueueDbJob(...a),
}));
const downloadFile = vi.fn();
const uploadFile = vi.fn();
vi.mock("../../lib/storage", () => ({
    downloadFile: (...a: unknown[]) => downloadFile(...a),
    uploadFile: (...a: unknown[]) => uploadFile(...a),
}));

const docxToPdf = vi.fn();
vi.mock("../../lib/convert", () => ({
    docxToPdf: (...a: unknown[]) => docxToPdf(...a),
    convertedPdfKey: (userId: string, docId: string) =>
        `converted-pdfs/${userId}/${docId}.pdf`,
}));

import {
    runConversionJob,
    setDocumentTerminalStatus,
    isPermanentFailure,
} from "../conversionWorker";
import type { Job } from "bullmq";
import type { ConversionJobData } from "../../lib/queue/conversionQueue";

type Call = {
    table: string;
    update: Record<string, unknown>;
    filters: Record<string, unknown>;
};

// Chainable Supabase double. `errors` lets a test make one table's update
// fail the way PostgREST does — by RESOLVING with an `error` field, not by
// throwing — which is precisely the failure mode the worker used to ignore.
function makeDb(
    errors: Record<string, { message: string }> = {},
    matched = true,
) {
    const calls: Call[] = [];
    return {
        calls,
        from(table: string) {
            const call: Call = { table, update: {}, filters: {} };
            const b: Record<string, unknown> = {
                update(update: Record<string, unknown>) {
                    call.update = update;
                    return b;
                },
                eq(col: string, val: unknown) {
                    call.filters[col] = val;
                    return b;
                },
                is(col: string, val: unknown) {
                    call.filters[col] = val;
                    return b;
                },
                select() {
                    return b;
                },
                maybeSingle() {
                    return b;
                },
                then(onF: (v: unknown) => unknown) {
                    calls.push(call);
                    return Promise.resolve({
                        data: matched ? { id: "ver-1" } : null,
                        error: errors[table] ?? null,
                    }).then(onF);
                },
            };
            return b;
        },
    };
}

const JOB = {
    documentId: "doc-1",
    versionId: "ver-1",
    userId: "user-1",
    storagePath: "uploads/user-1/doc-1.docx",
    fileType: "docx",
};

beforeEach(() => {
    enqueueDbJob.mockReset();
    downloadFile.mockReset();
    uploadFile.mockReset();
    docxToPdf.mockReset();
});

describe("runConversionJob", () => {
    it("converts, stores the PDF, and flips the document to ready", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockResolvedValue(undefined);
        const db = makeDb();

        await runConversionJob(JOB, db as never);

        expect(uploadFile).toHaveBeenCalledWith(
            "converted-pdfs/user-1/doc-1.pdf",
            expect.anything(),
            "application/pdf",
        );
        expect(db.calls).toContainEqual({
            table: "document_versions",
            update: { pdf_storage_path: "converted-pdfs/user-1/doc-1.pdf" },
            filters: {
                id: "ver-1",
                storage_path: JOB.storagePath,
                document_id: "doc-1",
                deleted_at: null,
            },
        });
        const docUpdate = db.calls.find((c) => c.table === "documents");
        expect(docUpdate?.update.status).toBe("ready");
    });

    it("queues late output for cleanup when its version was deleted or replaced", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("pdf"));
        const db = makeDb({}, false);
        await runConversionJob(
            { ...JOB, finalizeDocumentStatus: false },
            db as never,
        );
        expect(enqueueDbJob).toHaveBeenCalledWith(db, {
            kind: "document.cleanup",
            payload: {
                versionId: "ver-1",
                keys: ["converted-pdfs/user-1/doc-1.pdf"],
            },
        });
    });

    it("treats a conversion failure as non-fatal: still marks ready, no PDF stored", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockRejectedValue(new Error("soffice exploded"));
        const db = makeDb();

        await runConversionJob(JOB, db as never);

        expect(uploadFile).not.toHaveBeenCalled();
        expect(db.calls.some((c) => c.table === "document_versions")).toBe(
            false,
        );
        const docUpdate = db.calls.find((c) => c.table === "documents");
        expect(docUpdate?.update.status).toBe("ready");
    });

    it("writes the rendition to the payload's pdfKey when provided", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockResolvedValue(undefined);
        const db = makeDb();

        await runConversionJob(
            { ...JOB, pdfKey: "converted-pdfs/user-1/doc-1/slug.pdf" },
            db as never,
        );

        expect(uploadFile).toHaveBeenCalledWith(
            "converted-pdfs/user-1/doc-1/slug.pdf",
            expect.anything(),
            "application/pdf",
        );
        expect(db.calls).toContainEqual({
            table: "document_versions",
            update: {
                pdf_storage_path: "converted-pdfs/user-1/doc-1/slug.pdf",
            },
            filters: {
                id: "ver-1",
                storage_path: JOB.storagePath,
                document_id: "doc-1",
                deleted_at: null,
            },
        });
    });

    it("never touches documents.status when finalizeDocumentStatus is false", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockResolvedValue(undefined);
        const db = makeDb();

        await runConversionJob(
            { ...JOB, finalizeDocumentStatus: false },
            db as never,
        );

        expect(db.calls.some((c) => c.table === "documents")).toBe(false);
        // The version row still gets its rendition.
        expect(db.calls.some((c) => c.table === "document_versions")).toBe(
            true,
        );
    });

    it("leaves the document alone on conversion failure when finalizeDocumentStatus is false", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockRejectedValue(new Error("soffice exploded"));
        const db = makeDb();

        await runConversionJob(
            { ...JOB, finalizeDocumentStatus: false },
            db as never,
        );

        expect(db.calls).toHaveLength(0);
    });

    it("throws when the original is missing so BullMQ retries", async () => {
        downloadFile.mockResolvedValue(null);
        const db = makeDb();

        await expect(runConversionJob(JOB, db as never)).rejects.toThrow(
            /original not found/,
        );
        expect(docxToPdf).not.toHaveBeenCalled();
        expect(db.calls).toHaveLength(0);
    });

    // The retry budget only protects what it wraps. These three failures are
    // all fixable by a retry, so none of them may be swallowed as if the
    // conversion itself had failed.
    it("throws when storing the rendition fails, so the retry budget applies", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockRejectedValue(new Error("storage 503"));
        const db = makeDb();

        await expect(runConversionJob(JOB, db as never)).rejects.toThrow(
            /storage 503/,
        );
        // Nothing was finalized: the document stays "processing" for the retry
        // rather than going "ready" with no rendition it will never get.
        expect(db.calls).toHaveLength(0);
    });

    it("throws when the version rendition update returns an error", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockResolvedValue(undefined);
        const db = makeDb({ document_versions: { message: "deadlock" } });

        await expect(runConversionJob(JOB, db as never)).rejects.toThrow(
            /rendition update failed: deadlock/,
        );
        expect(db.calls.some((c) => c.table === "documents")).toBe(false);
    });

    it("throws when the document finalize update returns an error", async () => {
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockResolvedValue(undefined);
        const db = makeDb({ documents: { message: "conn reset" } });

        await expect(runConversionJob(JOB, db as never)).rejects.toThrow(
            /document finalize failed: conn reset/,
        );
    });

    it("fences the rendition write on the storage key it converted", async () => {
        // Replace-file reuses the versionId, so two conversions of one version
        // can be in flight at once. Without the storage_path filter the loser
        // of that race — the one holding the OLDER bytes — can finish last and
        // stamp its rendition over the newer one.
        downloadFile.mockResolvedValue(new ArrayBuffer(8));
        docxToPdf.mockResolvedValue(Buffer.from("%PDF-1.7 fake"));
        uploadFile.mockResolvedValue(undefined);
        const db = makeDb();

        await runConversionJob(
            { ...JOB, storagePath: "uploads/user-1/superseded.docx" },
            db as never,
        );

        const versionCall = db.calls.find(
            (c) => c.table === "document_versions",
        );
        expect(versionCall?.filters).toEqual({
            id: "ver-1",
            storage_path: "uploads/user-1/superseded.docx",
            document_id: "doc-1",
            deleted_at: null,
        });
    });
});

describe("setDocumentTerminalStatus", () => {
    it("updates the document to the given terminal status", async () => {
        const db = makeDb();

        await setDocumentTerminalStatus(db as never, "doc-1", "error");

        expect(db.calls).toHaveLength(1);
        expect(db.calls[0].table).toBe("documents");
        expect(db.calls[0].update.status).toBe("error");
        expect(db.calls[0].update).toHaveProperty("updated_at");
    });
});

describe("isPermanentFailure", () => {
    const job = (attemptsMade: number, attempts?: number) =>
        ({
            attemptsMade,
            opts: { attempts },
        }) as unknown as Job<ConversionJobData>;

    it("is false while retries remain", () => {
        expect(isPermanentFailure(job(1, 3))).toBe(false);
        expect(isPermanentFailure(job(2, 3))).toBe(false);
    });

    it("is true once retries are exhausted", () => {
        expect(isPermanentFailure(job(3, 3))).toBe(true);
        expect(isPermanentFailure(job(4, 3))).toBe(true);
    });

    it("defaults to a single attempt when opts.attempts is unset", () => {
        expect(isPermanentFailure(job(1))).toBe(true);
        expect(isPermanentFailure(job(0))).toBe(false);
    });
});
