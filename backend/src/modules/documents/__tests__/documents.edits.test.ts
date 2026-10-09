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

  it("rejects an editor save or competing review that wins before publication", async () => {
    arrange();
    const fake = scriptedDb([
      { table: "document_edits", data: PENDING_EDIT },
      { table: "documents", data: DOC },
      // Another writer changed storage_path while the resolved bytes uploaded.
      { table: "document_versions", op: "update", data: null },
    ]);
    expect(await run(fake.db)).toMatchObject({ ok: false, status: 409 });
    expect(storage.deleteFileBestEffort).toHaveBeenCalledWith(storage.uploadFile.mock.calls[0][0], "edit-resolution-conflict");
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
      { table: "document_edits", op: "update" },
      { table: "document_edits", data: [] },
    ]);
    expect((await run(fake.db)).ok).toBe(true);
    expect(storage.deleteFile.mock.calls.flat()).toEqual(expect.arrayContaining(["docs/v1.docx", "renditions/v1.pdf", "extracted-text/v1.txt"]));
    fake.done();
  });
});
