import { afterEach, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
import { ExtractionParseError } from "../../lib/extraction/failure";
import { markErrorHandled, reportError } from "../../lib/observability/sentry";
import { ExtractionBusyError, ExtractionLimitError } from "../../lib/extraction/limits";
import type { ExtractionJobData } from "../../lib/queue/extractionQueue";
import { AppError } from "../../lib/appError";
import { toProviderStreamError } from "../../lib/llm/providerErrors";

const mocks = vi.hoisted(() => ({ run: vi.fn(), failed: vi.fn(), on: vi.fn(), worker: vi.fn() }));
vi.mock("bullmq", async (importOriginal) => ({
    ...await importOriginal<typeof import("bullmq")>(),
    Worker: class {
        constructor(...args: unknown[]) { mocks.worker(...args); }
        on = mocks.on;
        close = vi.fn();
    },
}));
vi.mock("../../lib/queue/connection", () => ({ getRedisConnection: () => ({}), watchQueueErrors: vi.fn() }));
vi.mock("../../lib/observability/sentry", () => ({ reportError: vi.fn(), markErrorHandled: vi.fn(), isReported: () => false }));
vi.mock("../../modules/tabular/tabular.service", async () => ({
    isRefusalShownToUser: (await vi.importActual<typeof import("../../modules/tabular/tabular.extraction")>("../../modules/tabular/tabular.extraction")).isRefusalShownToUser,
    extractionJobOperation: () => "tabular.row",
    runExtractionJob: mocks.run,
    markExtractionFailed: mocks.failed,
}));
import { createExtractionWorker, stopExtractionWorker } from "../extraction.transport";

afterEach(async () => { await stopExtractionWorker(); vi.resetAllMocks(); });

it.each([new ExtractionLimitError("too large"), new ExtractionBusyError(), new ExtractionParseError("extraction.parse_failed", "unreadable docx")])(
    "applies BullMQ retry policy and terminal cleanup for %s",
    async (error) => {
        mocks.run.mockRejectedValueOnce(error);
        createExtractionWorker();
        const processJob = mocks.worker.mock.calls[0][1] as (job: Job<ExtractionJobData>) => Promise<void>;
        const onFailed = mocks.on.mock.calls.find(([event]) => event === "failed")![1] as
            (job: Job<ExtractionJobData>, error: Error) => Promise<void>;
        const job = { data: { reviewId: "review", rowId: "row" }, attemptsMade: 1, opts: { attempts: 3 } } as Job<ExtractionJobData>;
        const thrown = await processJob(job).catch((err: Error) => err);
        if (error instanceof ExtractionLimitError || error instanceof ExtractionParseError) expect(thrown).toBeInstanceOf(UnrecoverableError);
        else expect(thrown).toBe(error);
        if (thrown instanceof UnrecoverableError) expect(thrown.cause).toBe(error);
        await onFailed(job, thrown as Error);
        if (error instanceof ExtractionParseError) expect(reportError).toHaveBeenCalledWith(thrown, expect.objectContaining({ level: "warning", tags: expect.objectContaining({ terminal: true }) }));
        if (error instanceof ExtractionLimitError || error instanceof ExtractionParseError) expect(mocks.failed).toHaveBeenCalledWith(job.data);
        else expect(mocks.failed).not.toHaveBeenCalled();
    },
);

/** The error runExtractionJob ends with when the provider failed the row. */
function providerFailure(statusCode: number, keySource: "user" | "deployment"): Error {
    const answer = Object.assign(new Error(`${statusCode} from provider`), { name: "AI_APICallError", statusCode, responseBody: "" });
    const cause = toProviderStreamError(answer, { label: "Anthropic", modelId: "m", keySource, provider: "claude" });
    return new AppError("tabular.generation_failed", "[extraction-worker] incomplete extraction for row row", { cause });
}

async function runFailedAttempt(error: Error) {
    mocks.run.mockRejectedValueOnce(error);
    createExtractionWorker();
    const processJob = mocks.worker.mock.calls[0][1] as (job: Job<ExtractionJobData>) => Promise<void>;
    const onFailed = mocks.on.mock.calls.find(([event]) => event === "failed")![1] as
        (job: Job<ExtractionJobData>, error: Error) => Promise<void>;
    const job = { data: { reviewId: "review", rowId: "row" }, attemptsMade: 1, opts: { attempts: 3 } } as Job<ExtractionJobData>;
    const thrown = await processJob(job).catch((err: Error) => err);
    await onFailed(job, thrown as Error);
    return { thrown, job };
}

// A provider refusal answers the same on every attempt: fail the row at once,
// at the level the chat engine gives the same refusal. A user's own rejected
// key is not reported at all: the grid was sent the remedy.
it.each([
    ["the user's own key", 401, "user", null],
    ["the user's out-of-credits account", 402, "user", "warning"],
    ["the deployment's key", 401, "deployment", "error"],
] as const)("ends retries on the first attempt when the provider rejects %s", async (_name, status, keySource, level) => {
    const error = providerFailure(status, keySource);
    const { thrown, job } = await runFailedAttempt(error);
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).cause).toBe(error);
    if (level === null) {
        expect(reportError).not.toHaveBeenCalled();
        // Its log line must not reach Sentry through the console bridge.
        expect(markErrorHandled).toHaveBeenCalledWith(thrown);
    } else {
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(thrown, expect.objectContaining({ level, tags: expect.objectContaining({ terminal: true }) }));
    }
    expect(mocks.failed).toHaveBeenCalledWith(job.data);
});

// The counterexample: a transient provider failure keeps its retries.
it.each([503, 429])("keeps retrying a provider %i", async (status) => {
    const error = providerFailure(status, "user");
    const { thrown } = await runFailedAttempt(error);
    expect(thrown).toBe(error);
    expect(reportError).toHaveBeenCalledWith(thrown, expect.objectContaining({ level: "warning", tags: expect.objectContaining({ terminal: false }) }));
    expect(mocks.failed).not.toHaveBeenCalled();
});
