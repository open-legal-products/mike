import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../../../__tests__/helpers/scriptedDb";
import type { Db } from "../../../../../lib/supabase";
const mocks = vi.hoisted(() => ({
  active: vi.fn(),
  downloadFile: vi.fn(),
  uploadFile: vi.fn(),
  apply: vi.fn(),
}));
vi.mock("../../../../../lib/documentVersions", () => ({
  loadActiveVersion: mocks.active,
  contentSha256: () => "hash",
}));
vi.mock("../../../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
}));
vi.mock("../../../../../lib/docxTrackedChanges", () => ({
  applyTrackedEdits: mocks.apply,
}));
vi.mock("../../../../../lib/downloadTokens", () => ({
  buildDownloadUrl: (path: string, filename: string) =>
    `download:${filename}:${path}`,
}));
import { runEditDocument } from "../documentOps";
const change = {
  id: "change",
  delId: "del",
  insId: "ins",
  deletedText: "old",
  insertedText: "new",
  contextBefore: "before",
  contextAfter: "after",
  reason: "clarify",
};
const editRow = {
  id: "edit",
  change_id: "change",
  deleted_text: "old",
  inserted_text: "new",
  context_before: "before",
  context_after: "after",
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.active.mockResolvedValue({
    id: "active",
    filename: "Renamed.docx",
    storage_path: "current",
  });
  mocks.downloadFile.mockResolvedValue(new ArrayBuffer(4));
  mocks.apply.mockResolvedValue({
    bytes: Buffer.from("edited"),
    changes: [change],
    errors: [],
  });
});
const initial = () => [
  { table: "documents", data: { id: "doc" } },
  { table: "user_profiles", data: { display_name: "Author" } },
];
function newVersionDb(
  options: {
    editsFail?: boolean;
    createFail?: boolean;
    activation?: boolean;
  } = {},
) {
  const fake = scriptedDb([
    ...initial(),
    { table: "document_versions", data: { filename: "Renamed.docx" } },
    ...(!options.createFail
      ? [
          {
            table: "document_edits",
            op: "insert",
            data: options.editsFail ? null : [editRow],
            error: options.editsFail ? { message: "edit insert failed" } : null,
          },
        ]
      : []),
  ]);
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "create_document_version") {
      expect(fake.calls.some((call) => call.table === "document_edits")).toBe(
        false,
      );
      expect(params.p_activate).toBe(false);
      return options.createFail
        ? { data: null, error: { message: "version insert failed" } }
        : { data: { id: "version", version_number: 9 }, error: null };
    }
    expect(name).toBe("activate_document_version");
    expect(fake.calls.at(-1)?.table).toBe("document_edits");
    return { data: options.activation !== false, error: null };
  });
  const db = { ...fake.db, rpc } as unknown as Db;
  return { ...fake, db, rpc };
}
const run = (
  db: Db,
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  },
) =>
  runEditDocument({
    db,
    documentId: "doc",
    userId: "actor",
    edits: [],
    reuseVersion,
  });
describe("assistant document-edit lifecycle", () => {
  it("saves edit rows before activation and returns annotations with the allocated version and inherited filename", async () => {
    const fake = newVersionDb();
    const result = await run(fake.db);
    expect(result).toMatchObject({
      ok: true,
      version_id: "version",
      version_number: 9,
      errors: [],
      annotations: [
        {
          kind: "edit",
          edit_id: "edit",
          document_id: "doc",
          version_id: "version",
          version_number: 9,
          deleted_text: "old",
          inserted_text: "new",
          reason: "clarify",
          status: "pending",
        },
      ],
    });
    if (result.ok) expect(result.download_url).toContain("Renamed.docx");
    expect(fake.rpc.mock.calls[0][1].p_version).not.toHaveProperty(
      "version_number",
    );
    expect(
      fake.calls.find((call) => call.table === "document_edits")?.payload,
    ).toEqual([
      expect.objectContaining({
        document_id: "doc",
        version_id: "version",
        change_id: "change",
        del_w_id: "del",
        ins_w_id: "ins",
      }),
    ]);
    fake.done();
  });
  it("does not activate a new version if saving its edits fails", async () => {
    const fake = newVersionDb({ editsFail: true });
    expect(await run(fake.db)).toEqual({
      ok: false,
      error: "Failed to record edits.",
    });
    expect(fake.rpc.mock.calls.map((call) => call[0])).toEqual([
      "create_document_version",
    ]);
    fake.done();
  });
  it("reports insertion failure without persisting edits or activating", async () => {
    const fake = newVersionDb({ createFail: true });
    expect(await run(fake.db)).toEqual({
      ok: false,
      error: "Failed to record document version.",
    });
    expect(fake.rpc).toHaveBeenCalledOnce();
    fake.done();
  });
  it("does not report success if the target was deleted before activation", async () => {
    const fake = newVersionDb({ activation: false });
    expect(await run(fake.db)).toEqual({
      ok: false,
      error: "Failed to activate document version.",
    });
    fake.done();
  });
  it("reuses the same turn's version and appends edits without allocating another version", async () => {
    const fake = scriptedDb([
      ...initial(),
      { table: "document_versions", op: "update", data: { id: "reused" } },
      { table: "document_versions", op: "update", data: { id: "reused" } },
      { table: "document_edits", op: "insert", data: [editRow] },
    ]);
    const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
    mocks.uploadFile.mockImplementation(async () => {
      expect(fake.calls.at(-1)?.payload).toEqual({ content_sha256: null });
    });
    const result = await run({ ...fake.db, rpc } as unknown as Db, {
      versionId: "reused",
      versionNumber: 7,
      storagePath: "same-turn",
    });
    expect(result).toMatchObject({
      ok: true,
      version_id: "reused",
      version_number: 7,
      storage_path: "same-turn",
      annotations: [{ version_id: "reused", version_number: 7 }],
    });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("activate_document_version", {
      p_document_id: "doc",
      p_version_id: "reused",
    });
    expect(fake.calls[3].payload).toMatchObject({
      content_sha256: "hash",
      pdf_storage_path: null,
    });
    fake.done();
  });
  it("does not overwrite a deleted same-turn version", async () => {
    const fake = scriptedDb([
      ...initial(),
      { table: "document_versions", op: "update", data: null },
    ]);
    expect(
      await run(fake.db, {
        versionId: "gone",
        versionNumber: 7,
        storagePath: "same-turn",
      }),
    ).toEqual({ ok: false, error: "Document version is unavailable." });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    fake.done();
  });
});
