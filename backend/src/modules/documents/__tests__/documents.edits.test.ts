import { afterEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const storage = vi.hoisted(() => ({
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  deleteFileBestEffort: vi.fn(),
  versionStorageKey: (_user: string, _doc: string, slug: string) => `new/${slug}.docx`,
  assertStorageConfigured: vi.fn(),
}));
const dbq = vi.hoisted(() => ({
  enqueueStorageCleanup: vi.fn(),
  requestDocumentCleanupDelivery: vi.fn(),
}));
const docx = vi.hoisted(() => ({ resolveTrackedChange: vi.fn() }));
const access = vi.hoisted(() => ({ ensureDocAccess: vi.fn() }));

vi.mock("../../../lib/storage", () => ({
  ...storage,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../lib/dbq/enqueue", () => dbq);
vi.mock("../../../lib/docxTrackedChanges", () => docx);
vi.mock("../../../lib/access", () => access);
vi.mock("../../../lib/permissions", () => ({ can: () => true }));
vi.mock("../../../lib/downloadTokens", () => ({
  buildDownloadUrl: () => "https://example.test/download",
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadActiveVersion: vi.fn(async () => ({
    id: "v1",
    storage_path: "docs/v1.docx",
    filename: "Clause.docx",
    version_number: 2,
    source: "assistant_edit",
  })),
}));

import { loadActiveVersion } from "../../../lib/documentVersions";
import { resolveEdit } from "../documents.edits";

const PENDING_EDIT = {
  id: "edit-1",
  document_id: "doc-1",
  change_id: "c1",
  del_w_id: "w-del",
  ins_w_id: "w-ins",
  status: "pending",
};
const DOC = {
  id: "doc-1",
  current_version_id: "v1",
  user_id: "user-1",
  project_id: null,
  org_id: null,
  workflow_id: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

function arrange() {
  storage.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  storage.uploadFile.mockResolvedValue(undefined);
  storage.deleteFile.mockResolvedValue(undefined);
  dbq.requestDocumentCleanupDelivery.mockResolvedValue(0);
  docx.resolveTrackedChange.mockResolvedValue({
    bytes: new Uint8Array([9, 9, 9]),
    found: true,
  });
  access.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "owner" });
}

const run = (db: Parameters<typeof resolveEdit>[5]) =>
  resolveEdit("accept", "doc-1", "edit-1", "user-1", "u@example.test", db);

describe("resolving a tracked edit", () => {
  it("publishes new immutable bytes and their hash in a single conditional update", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    storage.uploadFile.mockImplementation(async (key) => {
      expect(key).not.toBe("docs/v1.docx");
      expect(fake.calls.filter(call => call.table === "document_versions")).toHaveLength(0);
    });
    expect((await run(fake.db)).ok).toBe(true);
    const writes = fake.calls.filter(call => call.table === "document_versions");
    expect(writes).toHaveLength(1);
    expect(writes[0].payload).toEqual({ storage_path: storage.uploadFile.mock.calls[0][0], content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/), pdf_storage_path: null, size_bytes: 3 });
    expect(writes[0].filters).toEqual([["eq", "id", "v1"], ["eq", "document_id", "doc-1"], ["is", "deleted_at", null], ["eq", "storage_path", "docs/v1.docx"]]);
    fake.done();
  });

  it("redoes the resolution on the newer bytes when a concurrent review wins the swap", async () => {
    arrange();
    vi.mocked(loadActiveVersion)
      .mockResolvedValueOnce({ id: "v1", storage_path: "docs/v1.docx", filename: "Clause.docx", version_number: 2, source: "assistant_edit" } as never)
      .mockResolvedValueOnce({ id: "v1", storage_path: "docs/v1-other.docx", filename: "Clause.docx", version_number: 2, source: "assistant_edit" } as never);
    storage.downloadFile.mockImplementation(async (key: string) =>
      new Uint8Array(key === "docs/v1-other.docx" ? [7, 7] : [1, 2, 3]).buffer);
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      // Accepting another card on the same document swapped the path first.
      { table: "document_versions", op: "update", data: null },
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    expect((await run(fake.db)).ok).toBe(true);
    expect(storage.downloadFile.mock.calls.map(([key]) => key)).toEqual(["docs/v1.docx", "docs/v1-other.docx"]);
    expect([...docx.resolveTrackedChange.mock.calls[1][0]]).toEqual([7, 7]);
    const writes = fake.calls.filter(call => call.table === "document_versions");
    expect(writes[1].filters).toContainEqual(["eq", "storage_path", "docs/v1-other.docx"]);
    expect(writes[1].payload).toMatchObject({ storage_path: storage.uploadFile.mock.calls[1][0] });
    expect(storage.deleteFileBestEffort.mock.calls).toEqual([[storage.uploadFile.mock.calls[0][0], "edit-resolution-conflict"]]);
    fake.done();
  });

  it.each(["accept", "reject"] as const)("keeps the winner's bytes and status when a competing %s removed the change", async (mode) => {
    arrange();
    vi.mocked(loadActiveVersion)
      .mockResolvedValueOnce({ id: "v1", storage_path: "docs/v1.docx" } as never)
      .mockResolvedValueOnce({ id: "v1", storage_path: "docs/winner.docx" } as never);
    docx.resolveTrackedChange
      .mockResolvedValueOnce({ bytes: new Uint8Array([9]), found: true })
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), found: false });
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: null },
      // The winner's byte swap is visible before its separate status write.
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
    ]);
    expect(await resolveEdit(mode, "doc-1", "edit-1", "user-1", undefined, fake.db))
      .toMatchObject({ ok: false, status: 409 });
    expect(storage.downloadFile.mock.calls.map(([key]) => key)).toEqual(["docs/v1.docx", "docs/winner.docx"]);
    expect(storage.uploadFile).toHaveBeenCalledOnce();
    expect(storage.deleteFileBestEffort).toHaveBeenCalledWith(storage.uploadFile.mock.calls[0][0], "edit-resolution-conflict");
    expect(fake.calls.some(call => call.table === "document_edits" && call.op === "update")).toBe(false);
    fake.done();
  });

  it("returns the winner's recorded decision when the retry sees it resolved", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: null },
      { table: "document_edits", data: { ...PENDING_EDIT, status: "rejected" } },
      { table: "documents", data: DOC },
    ]);
    expect(await run(fake.db)).toMatchObject({ ok: true, body: { already_resolved: true, status: "rejected" } });
    expect(docx.resolveTrackedChange).toHaveBeenCalledOnce();
    expect(fake.calls.some(call => call.table === "document_edits" && call.op === "update")).toBe(false);
    fake.done();
  });

  it("answers 409 when every attempt loses the swap", async () => {
    arrange();
    // Another writer changed storage_path while each attempt's bytes uploaded.
    const lostAttempt = [
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", data: null },
    ] as const;
    const fake = scriptedDb(Array.from({ length: 5 }, () => lostAttempt).flat());
    expect(await run(fake.db)).toEqual({ ok: false, status: 409, detail: "This document changed. Reopen the latest version and try again." });
    expect(storage.uploadFile).toHaveBeenCalledTimes(5);
    expect(storage.deleteFileBestEffort.mock.calls).toEqual(storage.uploadFile.mock.calls.map(([key]) => [key, "edit-resolution-conflict"]));
    expect(fake.calls.some(call => call.table === "document_edits" && call.op === "update")).toBe(false);
    fake.done();
  });

  it("keeps the original bytes intact on a database failure without deleting a possibly committed upload", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", op: "update", error: { message: "write failed" } },
    ]);
    expect(await run(fake.db)).toMatchObject({ ok: false, error: { message: "write failed" } });
    expect(storage.uploadFile.mock.calls[0][0]).not.toBe("docs/v1.docx");
    expect(storage.deleteFileBestEffort).not.toHaveBeenCalled();
    fake.done();
  });

  it("retires the old object, PDF and text cache inline when jobs are disabled", async () => {
    arrange(); vi.stubEnv("DB_JOBS_ENABLED", "false");
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      { table: "document_versions", data: { storage_path: "docs/v1.docx", pdf_storage_path: "renditions/v1.pdf", content_sha256: "old" } },
      { table: "document_versions", op: "update", data: { id: "v1" } },
      { rpc: "document_cache_writer_active", data: false },
      { rpc: "document_cleanup_referenced_keys", data: [] },
      { table: "db_jobs", data: [] },
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    expect((await run(fake.db)).ok).toBe(true);
    expect(storage.deleteFile.mock.calls.flat()).toEqual(expect.arrayContaining(["docs/v1.docx", "renditions/v1.pdf", "extracted-text/v1.txt"]));
    fake.done();
  });
});
