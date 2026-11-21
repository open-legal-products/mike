// The storage.cleanup job used to throw a fresh Error on any failed delete,
// so the runner reported "deletes failed" with no kind, no operation and no
// SDK code. The first failure now travels as the cause, and the job names
// its operation so its events group under storage.cleanup.
import { beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
    deleteFile: vi.fn(),
    listFiles: vi.fn(),
    assertStorageConfigured: vi.fn(),
}));
vi.mock("../../storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../storage")>()),
    ...storage,
}));
const sentry = vi.hoisted(() => ({ setOperation: vi.fn() }));
vi.mock("../../observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../observability/sentry")>()),
    setOperation: sentry.setOperation,
}));

import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import { StorageOperationError } from "../../storage";
import { handleStorageCleanup } from "../storageCleanup";
import type { DbJob } from "../types";

const JOB = (payload: Record<string, unknown>): DbJob => ({
    id: "job-1",
    kind: "storage.cleanup",
    payload,
    status: "running",
    attempts: 1,
    max_attempts: 8,
    run_at: "",
    claimed_at: null,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "",
});

beforeEach(() => {
    vi.clearAllMocks();
    storage.deleteFile.mockResolvedValue(undefined);
    storage.listFiles.mockResolvedValue([]);
});

describe("handleStorageCleanup", () => {
    it("names its operation for every event the job produces", async () => {
        await handleStorageCleanup({} as never, JOB({ keys: ["a.pdf"] }));
        expect(sentry.setOperation).toHaveBeenCalledWith("storage.cleanup");
    });

    it("keeps the first delete failure as the cause of the retry error", async () => {
        const sdkError = Object.assign(new Error("access denied"), {
            name: "AccessDenied",
        });
        storage.deleteFile
            .mockRejectedValueOnce(new StorageOperationError("delete", { cause: sdkError }))
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("second failure"));

        const thrown = await handleStorageCleanup(
            {} as never,
            JOB({ keys: ["a.pdf", "b.pdf", "c.pdf"] }),
        ).catch((error: unknown) => error);

        // Every key was attempted; the summary message still counts them.
        expect(storage.deleteFile).toHaveBeenCalledTimes(3);
        expect(thrown).toMatchObject({ message: "[storage.cleanup] 2/3 deletes failed" });
        expect(diagnosticErrorTags(thrown)).toEqual({
            error_kind: "storage.delete_failed",
            storage_operation: "delete",
            failure_code: "AccessDenied",
        });
        // The keys stay out of the error that reaches the runner's report.
        expect(JSON.stringify(diagnosticErrorTags(thrown))).not.toContain("a.pdf");
    });
});
