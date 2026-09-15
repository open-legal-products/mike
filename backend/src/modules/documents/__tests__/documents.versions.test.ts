import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../lib/supabase";
import type { ProjectRole } from "../../../lib/permissions";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  active: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteSource: vi.fn(),
  enqueueConversion: vi.fn(),
}));
vi.mock("../documents.access", () => ({ ensureDocumentAccess: mocks.access }));
vi.mock("../documents.shared", () => ({
  deleteDocumentAndVersionFiles: mocks.deleteSource,
}));
vi.mock("../../../lib/documentVersions", () => ({
  loadActiveVersion: mocks.active,
  contentSha256: () => "hash",
}));
vi.mock("../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
  versionStorageKey: () => "destination/key",
}));
vi.mock("../../../lib/queue/conversionQueue", () => ({
  enqueueConversion: mocks.enqueueConversion,
}));
import {
  createVersionFromDocument,
  deleteVersion,
} from "../documents.versions";
const args = {
  documentId: "target",
  sourceDocumentId: "source",
  requestedFilename: null,
  userId: "actor",
  userEmail: undefined,
};
const access = (
  role: ProjectRole = "owner",
  creator = true,
  project = "target-project",
  workflow: string | null = null,
) => ({
  ok: true,
  isCreator: creator,
  projectRole: role,
  doc: {
    id: "doc",
    user_id: creator ? "actor" : "other",
    project_id: project,
    workflow_id: workflow,
  },
});
const row = {
  id: "new-version",
  version_number: 8,
  source: "user_upload",
  filename: "Clause.docx",
  created_at: "today",
  storage_path: "private",
  content_sha256: "private-hash",
};
const db = () => {
  const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
  return { rpc, db: { rpc } as unknown as Db };
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DB_JOBS_ENABLED", "true");
  vi.stubEnv("ASYNC_DOCUMENT_CONVERSION", "true");
  mocks.access.mockResolvedValue(access());
  mocks.active.mockResolvedValue({
    storage_path: "source/key",
    pdf_storage_path: "source/pdf",
    filename: "Clause.docx",
    file_type: "docx",
    page_count: 2,
  });
  mocks.downloadFile.mockResolvedValue(new ArrayBuffer(2));
  mocks.deleteSource.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());
describe("version copy caller policy", () => {
  it("copies across projects without deleting source and preserves the narrow response", async () => {
    mocks.access
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(access("viewer", false, "source-project"));
    const fake = db();
    expect(await createVersionFromDocument(args, fake.db)).toEqual({
      ok: true,
      version: {
        id: row.id,
        version_number: 8,
        source: row.source,
        filename: row.filename,
        created_at: row.created_at,
      },
    });
    expect(mocks.access.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ["target", "actor", undefined],
      ["source", "actor", undefined],
    ]);
    expect(mocks.deleteSource).not.toHaveBeenCalled();
    expect(fake.rpc).toHaveBeenCalledWith(
      "create_document_version",
      expect.objectContaining({
        p_document_id: "target",
        p_activate: true,
        p_version: expect.objectContaining({
          storage_path: "destination/key",
          source: "user_upload",
        }),
      }),
    );
  });
  it("moves a creator-owned source only after the destination commits", async () => {
    const fake = db();
    mocks.deleteSource.mockImplementation(async () => {
      expect(fake.rpc).toHaveBeenCalledOnce();
      return { error: null };
    });
    expect(await createVersionFromDocument(args, fake.db)).toMatchObject({
      ok: true,
    });
    expect(mocks.deleteSource).toHaveBeenCalledWith(fake.db, "source");
  });
  it.each(["target viewer", "missing source", "source owned by another user"])(
    "rejects %s before writing bytes",
    async (mode) => {
      if (mode === "target viewer")
        mocks.access.mockResolvedValueOnce(access("viewer", false));
      if (mode === "missing source")
        mocks.access
          .mockResolvedValueOnce(access())
          .mockResolvedValueOnce({ ok: false });
      if (mode === "source owned by another user")
        mocks.access
          .mockResolvedValueOnce(access())
          .mockResolvedValueOnce(access("editor", false));
      const fake = db();
      expect(await createVersionFromDocument(args, fake.db)).toMatchObject({
        ok: false,
      });
      expect(fake.rpc).not.toHaveBeenCalled();
      expect(mocks.uploadFile).not.toHaveBeenCalled();
    },
  );
  it("keeps the source when destination persistence fails", async () => {
    const fake = db();
    fake.rpc.mockResolvedValue({
      data: null,
      error: { message: "write failed" },
    });
    expect(await createVersionFromDocument(args, fake.db)).toMatchObject({
      ok: false,
      kind: "version_insert",
    });
    expect(mocks.deleteSource).not.toHaveBeenCalled();
  });
  it("tolerates a missing legacy PDF while retaining the copied original", async () => {
    mocks.downloadFile
      .mockResolvedValueOnce(new ArrayBuffer(2))
      .mockResolvedValueOnce(null);
    const fake = db();
    expect(await createVersionFromDocument(args, fake.db)).toMatchObject({
      ok: true,
    });
    expect(fake.rpc.mock.calls[0][1].p_version.pdf_storage_path).toBeNull();
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
  });
  it("queues conversion when the source has no rendition", async () => {
    mocks.active.mockResolvedValue({
      storage_path: "source/key",
      filename: "Clause.docx",
      file_type: "docx",
    });
    const fake = db();
    expect(await createVersionFromDocument(args, fake.db)).toMatchObject({
      ok: true,
    });
    expect(mocks.enqueueConversion).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "target",
        versionId: row.id,
        finalizeDocumentStatus: false,
      }),
    );
  });
});
describe("version deletion caller policy", () => {
  it.each([
    ["owner", true, null],
    ["editor", false, "workflow"],
  ] as const)(
    "permits %s creator=%s workflow=%s and preserves response",
    async (role, creator, workflow) => {
      mocks.access.mockResolvedValue(
        access(role, creator, "project", workflow),
      );
      const fake = db();
      const payload = {
        deleted_version_id: "v",
        current_version_id: "replacement",
        deleted_at: "today",
      };
      fake.rpc.mockResolvedValue({ data: payload, error: null });
      expect(
        await deleteVersion("target", "v", "actor", undefined, fake.db),
      ).toEqual({ ok: true, payload });
      expect(fake.rpc).toHaveBeenCalledWith("delete_document_version", {
        p_document_id: "target",
        p_version_id: "v",
        p_actor_id: "actor",
      });
    },
  );
  it.each([
    ["viewer", "workflow"],
    ["editor", null],
    ["owner", null],
  ] as const)(
    "denies a noncreator %s on workflow=%s",
    async (role, workflow) => {
      mocks.access.mockResolvedValue(access(role, false, "project", workflow));
      const fake = db();
      expect(
        await deleteVersion("target", "v", "actor", undefined, fake.db),
      ).toMatchObject({ ok: false, kind: "doc_not_found" });
      expect(fake.rpc).not.toHaveBeenCalled();
    },
  );
  it.each(["only_version", "version_not_found", "doc_not_found"])(
    "maps transaction result %s without claiming deletion",
    async (kind) => {
      const fake = db();
      fake.rpc.mockResolvedValue({ data: { kind }, error: null });
      expect(
        await deleteVersion("target", "v", "actor", undefined, fake.db),
      ).toMatchObject({ ok: false, kind });
    },
  );
});
