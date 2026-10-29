import { afterEach, expect, it, vi } from "vitest";
import { UnrecoverableError, type Job } from "bullmq";
import { ExtractionBusyError, ExtractionLimitError } from "../../lib/extraction/limits";
import type { ExtractionJobData } from "../../lib/queue/extractionQueue";

const mocks = vi.hoisted(() => ({ run: vi.fn(), failed: vi.fn(), on: vi.fn(), worker: vi.fn() }));
vi.mock("bullmq", async (importOriginal) => ({
    ...await importOriginal<typeof import("bullmq")>(),
    Worker: class {
        constructor(...args: unknown[]) { mocks.worker(...args); }
        on = mocks.on;
        close = vi.fn();
    },
}));
vi.mock("../../lib/queue/connection", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../../lib/observability/sentry", () => ({ reportError: vi.fn() }));
vi.mock("../../modules/tabular/tabular.service", () => ({
    extractionJobOperation: () => "tabular.row",
    runExtractionJob: mocks.run,
    markExtractionFailed: mocks.failed,
}));
import { createExtractionWorker, stopExtractionWorker } from "../extraction.transport";

afterEach(async () => { await stopExtractionWorker(); vi.resetAllMocks(); });

it.each([new ExtractionLimitError("too large"), new ExtractionBusyError()])(
    "applies BullMQ retry policy and terminal cleanup for %s",
    async (error) => {
        mocks.run.mockRejectedValueOnce(error);
        createExtractionWorker();
        const processJob = mocks.worker.mock.calls[0][1] as (job: Job<ExtractionJobData>) => Promise<void>;
        const onFailed = mocks.on.mock.calls.find(([event]) => event === "failed")![1] as
            (job: Job<ExtractionJobData>, error: Error) => Promise<void>;
        const job = { data: { reviewId: "review", rowId: "row" }, attemptsMade: 1, opts: { attempts: 3 } } as Job<ExtractionJobData>;
        const thrown = await processJob(job).catch((err: Error) => err);
        if (error instanceof ExtractionLimitError) expect(thrown).toBeInstanceOf(UnrecoverableError);
        else expect(thrown).toBe(error);
        await onFailed(job, thrown as Error);
        if (error instanceof ExtractionLimitError) expect(mocks.failed).toHaveBeenCalledWith(job.data);
        else expect(mocks.failed).not.toHaveBeenCalled();
    },
);
