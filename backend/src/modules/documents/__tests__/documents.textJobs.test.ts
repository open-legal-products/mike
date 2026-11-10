import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";
import { DbJobDeferredError } from "../../../lib/dbq/types";
import { NonRetryableJobError } from "../../../lib/dbq/runner";
import { ExtractionLimitError, withBackgroundExtraction } from "../../../lib/extraction/isolated";
const mocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  extractLegacyOfficeText: vi.fn(),
  enqueueDbJob: vi.fn(),
}));
vi.mock("../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../lib/pdfText", () => ({
  extractLegacyOfficeText: mocks.extractLegacyOfficeText,
}));
vi.mock("../../../lib/dbq/enqueue", () => ({
  enqueueDbJob: mocks.enqueueDbJob,
}));
const sentry = vi.hoisted(() => ({ setOperation: vi.fn() }));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/observability/sentry")>()),
  setOperation: sentry.setOperation,
}));
import { handleDocumentPrecomputeText } from "../documents.textJobs";
const job = {
  payload: { versionId: "v", storagePath: "old-source", fileType: "doc" },
  id: "text-job", kind: "document.precompute_text", status: "running", attempts: 1,
  max_attempts: 3, run_at: "", claimed_at: null, finished_at: null, last_error: null,
  dedupe_key: null, result: null, created_at: "",
} satisfies DbJob;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.downloadFile.mockResolvedValue(new ArrayBuffer(1));
  mocks.extractLegacyOfficeText.mockResolvedValue("extracted text");
});
it("does not write a deleted or replaced version's cache", async () => {
  const fake = scriptedDb([{ table: "document_versions", data: null }]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(mocks.downloadFile).not.toHaveBeenCalled();
  expect(mocks.uploadFile).not.toHaveBeenCalled();
  expect(mocks.enqueueDbJob).toHaveBeenCalledWith(fake.db, {
    kind: "document.cleanup",
    payload: { versionId: "v", keys: ["extracted-text/v.txt"] },
  });
  expect(fake.calls[0].filters).toEqual([
    ["eq", "id", "v"],
    ["eq", "storage_path", "old-source"],
    ["is", "deleted_at", null],
  ]);
  fake.done();
});
it("retires output if the version was deleted or replaced during extraction", async () => {
  const fake = scriptedDb([
    { table: "document_versions", data: { id: "v" } },
    { table: "document_versions", data: null },
  ]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(mocks.uploadFile).toHaveBeenCalledOnce();
  expect(mocks.enqueueDbJob).toHaveBeenCalledOnce();
  fake.done();
});
it("names its operation before any work, so a failure anywhere in it is tagged", async () => {
  const fake = scriptedDb([{ table: "document_versions", data: null }]);
  await handleDocumentPrecomputeText(fake.db, job);
  expect(sentry.setOperation).toHaveBeenCalledWith("documents.precompute_text");
  fake.done();
});
it("does not write when it cannot establish version liveness", async () => {
  const error = new Error("database unavailable");
  const fake = scriptedDb([{ table: "document_versions", error }]);
  await expect(handleDocumentPrecomputeText(fake.db, job)).rejects.toBe(error);
  expect(mocks.uploadFile).not.toHaveBeenCalled();
  expect(mocks.enqueueDbJob).not.toHaveBeenCalled();
  fake.done();
});
it("propagates cleanup scheduling failure so the worker retries", async () => {
  const fake = scriptedDb([{ table: "document_versions", data: null }]);
  mocks.enqueueDbJob.mockRejectedValue(new Error("queue unavailable"));
  await expect(handleDocumentPrecomputeText(fake.db, job)).rejects.toThrow(
    "queue unavailable",
  );
});
afterEach(() => vi.useRealTimers());
it("defers busy precomputation before reading metadata or downloading", async () => {
  let release!: () => void;
  const held = withBackgroundExtraction({}, () => new Promise<void>((resolve) => { release = resolve; }));
  const fake = scriptedDb([]);
  vi.useFakeTimers();
  try {
    const rejected = expect(handleDocumentPrecomputeText(fake.db, job)).rejects.toBeInstanceOf(DbJobDeferredError);
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    fake.done();
  } finally { release(); await held; }
});
it("does not retry or publish a precomputation that exceeds parser limits", async () => {
  const fake = scriptedDb([{ table: "document_versions", data: { id: "v" } }]);
  mocks.extractLegacyOfficeText.mockRejectedValue(new ExtractionLimitError("parser deadline exceeded"));
  await expect(handleDocumentPrecomputeText(fake.db, job)).rejects.toBeInstanceOf(NonRetryableJobError);
  expect(mocks.uploadFile).not.toHaveBeenCalled();
  fake.done();
});
