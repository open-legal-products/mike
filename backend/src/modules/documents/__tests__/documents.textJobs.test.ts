import { beforeEach, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";
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
