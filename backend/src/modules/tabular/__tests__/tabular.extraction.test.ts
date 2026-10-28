// What the extraction worker says about a row it could not finish.
//
// Three facts about a failed row used to arrive at Sentry as text without a
// name: an incomplete extraction was `new Error(...)` with the provider's
// error dropped on the floor, and a lost or unrenewable lease was a
// `console.error` of a plain object. Each now carries a kind, the original
// failure as its cause, and only ids as context.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const service = vi.hoisted(() => ({
    extractRowColumns: vi.fn(),
    finalizeCell: vi.fn(),
    finishGenerationIfIdle: vi.fn(),
    loadReviewRow: vi.fn(),
    renewGeneration: vi.fn(),
    validateSelectedModel: vi.fn(),
}));
vi.mock("../tabular.service", () => ({
    ...service,
    TABULAR_GENERATION_HEARTBEAT_MS: 1_000,
}));
vi.mock("../../chat/chat.service", () => ({
    assistantStreamErrorPayload: () => ({ message: "Generation failed" }),
}));
vi.mock("../../../lib/queue/runProgress", () => ({
    publishCellUpdate: vi.fn(),
}));
vi.mock("../../../lib/supabase", () => ({
    createServerSupabase: () => ({}),
}));
const { reportError, setOperation } = vi.hoisted(() => ({
    reportError: vi.fn(),
    setOperation: vi.fn(),
}));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../../lib/observability/sentry")
    >()),
    reportError,
    setOperation,
}));

import { AppError } from "../../../lib/appError";
import { diagnosticErrorTags } from "../../../lib/observability/sentryPrivacy";
import { runExtractionJob } from "../tabular.extraction";
import { makeFakeDb, type FakeDbSpec } from "./fakeDb";

const REVIEW_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";
const GENERATION_ID = "33333333-3333-4333-8333-333333333333";
const COLUMN = { index: 0, name: "A", prompt: "a" };
const ROW = {
    id: ROW_ID,
    review_id: REVIEW_ID,
    label: "Contract.pdf",
    row_type: "document",
    folder_id: null,
    library_folder_id: null,
    document_id: "doc-1",
    sort_index: 0,
    source_document_ids: ["doc-1"],
};

function reviewDb(spec: FakeDbSpec = {}) {
    return makeFakeDb({
        tables: {
            tabular_reviews: {
                data: { columns_config: [COLUMN], model: "m", org_id: null },
                error: null,
            },
            tabular_cells: { data: [], error: null },
            ...spec.tables,
        },
    });
}

function run(db: ReturnType<typeof makeFakeDb>["db"], generationId?: string) {
    return runExtractionJob(
        { reviewId: REVIEW_ID, userId: "user-1", rowId: ROW_ID, generationId },
        { db, publish: vi.fn().mockResolvedValue(undefined) },
    );
}

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    vi.clearAllMocks();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    service.loadReviewRow.mockResolvedValue(ROW);
    service.validateSelectedModel.mockResolvedValue({
        ok: true,
        model: "m",
        apiKeys: {},
    });
    service.renewGeneration.mockResolvedValue(true);
    service.finishGenerationIfIdle.mockResolvedValue(undefined);
});
afterEach(() => {
    vi.useRealTimers();
    consoleError.mockRestore();
});

describe("runExtractionJob", () => {
    it("names the operation by what the job fills: a row, or one cell", async () => {
        service.extractRowColumns.mockResolvedValue({
            processed: [],
            received: new Set(),
            missing: [],
        });
        await run(reviewDb().db);
        expect(setOperation).toHaveBeenLastCalledWith("tabular.row");

        await runExtractionJob(
            { reviewId: REVIEW_ID, userId: "user-1", rowId: ROW_ID, columnIndex: 0 },
            { db: reviewDb().db, publish: vi.fn() },
        );
        expect(setOperation).toHaveBeenLastCalledWith("tabular.cell");
    });

    it("throws an incomplete extraction under its kind with the provider's error as the cause", async () => {
        const providerError = Object.assign(new Error("rate limited"), {
            name: "AI_APICallError",
            statusCode: 429,
        });
        service.extractRowColumns.mockResolvedValue({
            processed: [COLUMN],
            received: new Set(),
            missing: [0],
            error: providerError,
        });

        const thrown = await run(reviewDb().db).catch((error: unknown) => error);

        // The runner reports what the job throws, so the kind and the cause
        // must be on the thrown object itself.
        expect(thrown).toBeInstanceOf(AppError);
        expect((thrown as AppError).kind).toBe("tabular.generation_failed");
        expect((thrown as AppError).cause).toBe(providerError);
        expect(service.extractRowColumns).toHaveBeenCalledWith(expect.objectContaining({ reportFailure: false }));
        expect(reportError).not.toHaveBeenCalled();
        expect((thrown as Error).message).toContain("missing columns 0");
    });

    it("throws an incomplete extraction with no cause when the model simply skipped a column", async () => {
        service.extractRowColumns.mockResolvedValue({
            processed: [COLUMN],
            received: new Set(),
            missing: [0],
        });
        const thrown = await run(reviewDb().db).catch((error: unknown) => error);
        expect(thrown).toBeInstanceOf(AppError);
        expect((thrown as AppError).cause).toBeUndefined();
    });

    it("reports a lost lease as a warning, by ids only, and keeps extracting", async () => {
        vi.useFakeTimers();
        service.renewGeneration.mockResolvedValue(false);
        let finish!: () => void;
        service.extractRowColumns.mockReturnValue(
            new Promise((resolve) => {
                finish = () =>
                    resolve({ processed: [], received: new Set(), missing: [] });
            }),
        );

        const job = run(reviewDb().db, GENERATION_ID);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported, context] = reportError.mock.calls[0];
        expect(reported).toBeInstanceOf(AppError);
        expect(reported.kind).toBe("tabular.lease_lost");
        expect(context).toEqual({
            level: "warning",
            tags: { component: "extraction-worker" },
            extra: { review_id: REVIEW_ID, row_id: ROW_ID },
        });
        // The log carries the reported object so the bridge files it once.
        expect(consoleError).toHaveBeenCalledWith(
            "[extraction-worker] generation lease lost",
            expect.objectContaining({ err: reported }),
        );

        finish();
        await expect(job).resolves.toBeUndefined();
    });

    it("reports a renewal that failed with the database's error as the cause", async () => {
        vi.useFakeTimers();
        const refused = { code: "57014", message: "canceled" };
        service.renewGeneration.mockRejectedValue(refused);
        let finish!: () => void;
        service.extractRowColumns.mockReturnValue(
            new Promise((resolve) => {
                finish = () =>
                    resolve({ processed: [], received: new Set(), missing: [] });
            }),
        );

        const job = run(reviewDb().db, GENERATION_ID);
        await vi.advanceTimersByTimeAsync(1_000);

        const [reported] = reportError.mock.calls[0];
        expect(reported.kind).toBe("tabular.lease_lost");
        // A PostgREST plain object is given a stack and keeps its code on
        // the cause chain, where the boundary reads it as failure_code.
        expect(reported.cause).toBeInstanceOf(Error);
        expect(diagnosticErrorTags(reported)).toEqual({
            error_kind: "tabular.lease_lost",
            failure_code: "57014",
        });

        finish();
        await expect(job).resolves.toBeUndefined();
    });

    it("reports a generation stamp that could not be cleared, with the cause", async () => {
        service.extractRowColumns.mockResolvedValue({
            processed: [COLUMN],
            received: new Set([0]),
            missing: [],
        });
        const refused = { code: "42501", message: "permission denied" };
        const fake = reviewDb({
            tables: {
                tabular_cells: [
                    { data: [], error: null },
                    { data: null, error: refused },
                ],
            },
        });

        await run(fake.db, GENERATION_ID);

        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported, context] = reportError.mock.calls[0];
        expect(reported.kind).toBe("tabular.lease_lost");
        expect(diagnosticErrorTags(reported)).toEqual({
            error_kind: "tabular.lease_lost",
            failure_code: "42501",
        });
        expect(context).toMatchObject({ level: "warning" });
        expect(consoleError).toHaveBeenCalledWith(
            "[extraction-worker] failed to clear generation stamp",
            expect.objectContaining({ error: reported }),
        );
    });
});
