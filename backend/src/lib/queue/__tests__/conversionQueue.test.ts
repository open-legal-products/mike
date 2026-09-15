import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { Db } from "../../supabase";
import type {
    EnqueueDbJobInput,
    EnqueueDbJobResult,
} from "../../dbq/enqueue";

// These suites pin the REDIS driver's BullMQ semantics; the Postgres-driver
// routing (same identities, DB queue transport) is pinned separately below.
process.env.QUEUE_DRIVER = "redis";
afterAll(() => {
    delete process.env.QUEUE_DRIVER;
});

// Both stubs carry the signature of what they replace, so the recorded calls
// below are real argument tuples instead of untyped rest arrays.
const enqueueDbJob = vi.fn<
    (db: Db, input: EnqueueDbJobInput) => Promise<EnqueueDbJobResult>
>(async () => ({ id: "dbjob-1", deduped: false }));
vi.mock("../../dbq/enqueue", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../dbq/enqueue")>();
    return {
        ...actual,
        enqueueDbJob: (db: Db, input: EnqueueDbJobInput) =>
            enqueueDbJob(db, input),
    };
});
const rpc = vi.fn<
    (
        fn: string,
        params: Record<string, unknown>,
    ) => Promise<{ data: unknown; error: { message: string } | null }>
>(async () => ({ data: 0, error: null }));
vi.mock("../../supabase", () => ({
    createServerSupabase: () => ({
        rpc: (fn: string, params: Record<string, unknown>) => rpc(fn, params),
    }),
}));

// One stable object per mock: the real getter returns the SAME instance
// until a wedge replaces it, and the queue getters rebuild on identity
// change — a fresh {} per call would look like a replacement every time.
const fakeProducerConnection = {};
vi.mock("../connection", () => ({
    getRedisConnection: () => ({}),
    getRedisProducerConnection: () => fakeProducerConnection,
    withRedisTimeout: <T,>(_label: string, run: () => Promise<T>) => run(),
}));

const add = vi.fn();
vi.mock("bullmq", () => ({
    Queue: class {
        add = add;
    },
}));

import {
    conversionJobId,
    enqueueConversion,
    type ConversionJobData,
} from "../conversionQueue";

const DATA: ConversionJobData = {
    documentId: "doc-1",
    versionId: "ver-1",
    userId: "user-1",
    storagePath: "uploads/user-1/doc-1.docx",
    fileType: "docx",
};

beforeEach(() => {
    add.mockReset();
});

describe("conversionJobId", () => {
    it("is deterministic on (versionId, storagePath)", () => {
        expect(conversionJobId("ver-1", DATA.storagePath)).toBe(
            conversionJobId("ver-1", DATA.storagePath),
        );
        expect(conversionJobId("ver-1", DATA.storagePath)).toMatch(
            /^convert_ver-1_[0-9a-f]{12}$/,
        );
    });

    // Replace-file reuses the versionId but always mints a NEW storage key.
    // A version-only id therefore collapses the second replace into the job
    // still carrying the first upload's key: the enqueue reports success and
    // the new bytes are never converted.
    it("gives a re-uploaded file its own id so a re-replace is not deduped away", () => {
        expect(conversionJobId("ver-1", "uploads/user-1/aaa.docx")).not.toBe(
            conversionJobId("ver-1", "uploads/user-1/bbb.docx"),
        );
    });

    it("keeps colons out of the id (BullMQ reserves them)", () => {
        expect(conversionJobId("ver-1", DATA.storagePath)).not.toContain(":");
    });
});

describe("enqueueConversion", () => {
    it("dedupes on the (version, storage key) identity", () => {
        enqueueConversion(DATA);

        expect(add).toHaveBeenCalledTimes(1);
        const [name, data, opts] = add.mock.calls[0];
        expect(name).toBe("convert");
        expect(data).toEqual(DATA);
        expect(opts.jobId).toBe(
            conversionJobId(DATA.versionId, DATA.storagePath),
        );
    });

    it("does not dedupe a second replace of the same version", async () => {
        await enqueueConversion(DATA);
        await enqueueConversion({
            ...DATA,
            storagePath: "uploads/user-1/doc-1-replaced.docx",
        });

        expect(add).toHaveBeenCalledTimes(2);
        expect(add.mock.calls[0][2].jobId).not.toBe(add.mock.calls[1][2].jobId);
    });

    it("retries with backoff and removes terminal jobs so re-conversions can re-enqueue", () => {
        enqueueConversion(DATA);

        const opts = add.mock.calls[0][2];
        expect(opts.attempts).toBe(3);
        expect(opts.backoff).toEqual({ type: "exponential", delay: 2000 });
        // Immediate removal (not keep-N) is deliberate: replace-file reuses
        // the versionId, and a lingering completed job record would silently
        // dedupe the re-conversion into the old job.
        expect(opts.removeOnComplete).toBe(true);
        expect(opts.removeOnFail).toBe(true);
    });

    it("carries the version-flow fields (pdfKey, finalizeDocumentStatus) through", () => {
        enqueueConversion({
            ...DATA,
            pdfKey: "converted-pdfs/user-1/doc-1/slug.pdf",
            finalizeDocumentStatus: false,
        });

        const data = add.mock.calls[0][1];
        expect(data.pdfKey).toBe("converted-pdfs/user-1/doc-1/slug.pdf");
        expect(data.finalizeDocumentStatus).toBe(false);
    });
});

describe("enqueueConversion (postgres driver)", () => {
    it("routes to the DB queue with the same dedupe identity and retry budget", async () => {
        process.env.QUEUE_DRIVER = "postgres";
        try {
            enqueueDbJob.mockClear();
            await enqueueConversion({
                documentId: "doc-1",
                versionId: "ver-1",
                userId: "user-1",
                storagePath: "documents/user-1/doc-1/source.docx",
                fileType: "docx",
            });
            expect(enqueueDbJob).toHaveBeenCalledTimes(1);
            const [, input] = enqueueDbJob.mock.calls[0];
            expect(input.kind).toBe("conversion.convert");
            // The BullMQ jobId doubles as the DB dedupe key, so double
            // submits collapse identically on either transport.
            expect(input.dedupeKey).toBe(
                conversionJobId("ver-1", "documents/user-1/doc-1/source.docx"),
            );
            expect(input.maxAttempts).toBe(3);
        } finally {
            process.env.QUEUE_DRIVER = "redis";
        }
    });
});
