import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { createServerSupabase } from "../../supabase";
import type {
    EnqueueDbJobInput,
    EnqueueDbJobResult,
} from "../../dbq/enqueue";

type Db = ReturnType<typeof createServerSupabase>;

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

vi.mock("../connection", () => ({
    getRedisConnection: () => ({}),
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
    it("is deterministic on the versionId", () => {
        expect(conversionJobId("ver-1")).toBe("convert_ver-1");
    });
});

describe("enqueueConversion", () => {
    it("dedupes with a deterministic jobId of convert_<versionId>", () => {
        enqueueConversion(DATA);

        expect(add).toHaveBeenCalledTimes(1);
        const [name, data, opts] = add.mock.calls[0];
        expect(name).toBe("convert");
        expect(data).toEqual(DATA);
        expect(opts.jobId).toBe("convert_ver-1");
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
            expect(input.dedupeKey).toBe("convert_ver-1");
            expect(input.maxAttempts).toBe(3);
        } finally {
            process.env.QUEUE_DRIVER = "redis";
        }
    });
});
