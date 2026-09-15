import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { DbJobDeferredError } from "../../../lib/dbq/types";
const storage = vi.hoisted(() => ({
  deleteFile: vi.fn(),
  assertStorageConfigured: vi.fn(),
}));
vi.mock("../../../lib/storage", () => ({
  ...storage,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
import {
  handleDocumentCleanup,
  captureInlineDocumentCleanup,
  completeInlineDocumentCleanup,
} from "../documents.cleanupJobs";

beforeEach(() => {
  vi.clearAllMocks();
  storage.deleteFile.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
const job = (keys: unknown[]) => ({ payload: { keys } });

describe("document cleanup job", () => {
  it("deletes unreferenced source/PDF/cache keys once and keeps surviving shared bytes", async () => {
    const fake = scriptedDb([
      { table: "db_jobs", data: [] },
      { table: "document_versions", data: [{ storage_path: "shared" }] },
      {
        table: "document_versions",
        data: [{ pdf_storage_path: "shared-pdf" }],
      },
    ]);
    await handleDocumentCleanup(
      fake.db,
      job([
        "source",
        "pdf",
        "source",
        "shared",
        "shared-pdf",
        "extracted-text/v.txt",
        null,
        "",
      ]),
    );
    expect(storage.deleteFile.mock.calls.flat()).toEqual([
      "source",
      "pdf",
      "extracted-text/v.txt",
    ]);
    for (const call of fake.calls.slice(1))
      expect(call.filters).toContainEqual(["is", "deleted_at", null]);
    fake.done();
  });

  it("does no destructive work when reference lookup fails", async () => {
    const error = { message: "database unavailable" };
    const fake = scriptedDb([{ table: "document_versions", error }]);
    await expect(
      handleDocumentCleanup(fake.db, job(["source"])),
    ).rejects.toEqual(error);
    expect(storage.deleteFile).not.toHaveBeenCalled();
    fake.done();
  });

  it("attempts every key but reports failure so the job retries", async () => {
    const fake = scriptedDb([
      { table: "document_versions", data: [] },
      { table: "document_versions", data: [] },
    ]);
    storage.deleteFile.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(
      handleDocumentCleanup(fake.db, job(["a", "b"])),
    ).rejects.toThrow("document_cleanup_failed:1");
    expect(storage.deleteFile.mock.calls.flat()).toEqual(["a", "b"]);
  });

  it("defers cache cleanup while a worker can still produce its output", async () => {
    const fake = scriptedDb([
      { table: "db_jobs", data: [{ id: "running-precompute" }] },
    ]);
    await expect(
      handleDocumentCleanup(fake.db, job(["extracted-text/v.txt"])),
    ).rejects.toBeInstanceOf(DbJobDeferredError);
    expect(storage.deleteFile).not.toHaveBeenCalled();
    expect(fake.calls[0].filters).toContainEqual([
      "in",
      "payload->>versionId",
      ["v"],
    ]);
  });

  it("lets the database collect cleanup in the normal worker mode", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "true");
    const fake = scriptedDb([]);
    expect(
      await captureInlineDocumentCleanup(fake.db, { documentIds: ["doc"] }),
    ).toEqual([]);
    await completeInlineDocumentCleanup(fake.db, []);
    expect(storage.deleteFile).not.toHaveBeenCalled();
    fake.done();
  });

  it("captures all artifacts before deleting when workers are disabled", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const fake = scriptedDb([
      {
        table: "document_versions",
        data: [{ id: "v", storage_path: "source", pdf_storage_path: "pdf" }],
      },
    ]);
    expect(
      await captureInlineDocumentCleanup(fake.db, {
        documentIds: ["authorized-doc"],
      }),
    ).toEqual(["source", "pdf", "extracted-text/v.txt"]);
    expect(fake.calls[0].filters).toEqual([
      ["in", "document_id", ["authorized-doc"]],
    ]);
    fake.done();
  });
});
