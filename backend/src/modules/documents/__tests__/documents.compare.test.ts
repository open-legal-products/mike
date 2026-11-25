import { beforeEach, describe, expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { DocxDiffError, type DocxDiffEngine } from "../../../lib/docxDiff";

const mocks = vi.hoisted(() => ({ access: vi.fn(), downloadFile: vi.fn() }));
// Only the access verdict and object storage are stubbed. Version lookup
// (loadActiveVersion) runs for real against the in-memory tables, so the
// "belongs to this document" and "not deleted" rules under test are the
// production ones.
vi.mock("../documents.access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../documents.access")>()),
  ensureDocumentAccess: mocks.access,
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
}));
import { COMPARE_AUTHOR, COMPARE_MAX_VERSION_BYTES, compareVersions } from "../documents.compare";

const NOW = new Date("2026-11-24T12:00:00Z");
const version = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, document_id: "doc", version_number: n, storage_path: `doc/${id}.docx`, filename: "MSA.docx",
  file_type: "docx", size_bytes: 1000, deleted_at: null, ...extra,
});

function setup(versions = [version("v1", 1), version("v2", 2), version("v3", 3)]) {
  const fake = tableDb({
    documents: [{ id: "doc", current_version_id: "v3" }, { id: "other", current_version_id: "x1" }],
    document_versions: [...versions, version("x1", 1, { document_id: "other", storage_path: "other/x1.docx" })],
  });
  const compare = vi.fn<DocxDiffEngine["compare"]>(async () => ({
    redline: Buffer.from("redline"),
    revisions: [{ kind: "insert" as const, text: "sixty", wordIds: ["1"] }],
    summary: { insertions: 1, deletions: 0, moves: 0, formatChanges: 0, structuralChanges: 0, total: 1 },
  }));
  const engine: DocxDiffEngine = { id: "fake", compare };
  const run = (baseVersionId: string, targetVersionId: string, documentId = "doc") => compareVersions({
    documentId, userId: "u", userEmail: "u@example.com", baseVersionId, targetVersionId, db: fake.db, engine, now: NOW,
  });
  return { run, compare, fake };
}

beforeEach(() => {
  mocks.access.mockReset().mockResolvedValue({ ok: true, doc: { id: "doc" }, isCreator: true, projectRole: "owner" });
  mocks.downloadFile.mockReset().mockImplementation(async (key: string) => new TextEncoder().encode(key).buffer);
});

describe("compareVersions", () => {
  it("compares the base version's bytes against the target's, in that order", async () => {
    const { run, compare } = setup();
    const result = await run("v1", "v3");
    expect(result).toMatchObject({
      ok: true, engine: "fake",
      base: { id: "v1", version_number: 1 }, target: { id: "v3", version_number: 3 },
      summary: { insertions: 1, total: 1 },
      filename: "MSA (V1 to V3 comparison).docx",
    });
    const [original, revised, options] = compare.mock.calls[0];
    expect(original.toString()).toBe("doc/v1.docx");
    expect(revised.toString()).toBe("doc/v3.docx");
    expect(options).toEqual({ author: COMPARE_AUTHOR, date: NOW });
  });

  it("lets the caller compare newer-to-older without reordering them", async () => {
    const { run, compare } = setup();
    expect(await run("v3", "v1")).toMatchObject({ ok: true, filename: "MSA (V3 to V1 comparison).docx" });
    expect(compare.mock.calls[0][0].toString()).toBe("doc/v3.docx");
  });

  it("answers 'not found' for a document the caller cannot read, before touching versions or storage", async () => {
    const { run, compare, fake } = setup();
    mocks.access.mockResolvedValue({ ok: false, kind: "forbidden" });
    expect(await run("v1", "v2")).toEqual({ ok: false, kind: "not_found", detail: "Document not found" });
    expect(fake.calls).toEqual([]);
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("refuses a version that belongs to a different document", async () => {
    const { run, compare } = setup();
    expect(await run("v1", "x1")).toEqual({ ok: false, kind: "not_found", detail: "Version not found" });
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("refuses a deleted version and an unknown one", async () => {
    const { run } = setup([version("v1", 1), version("v2", 2, { deleted_at: "2026-11-01T00:00:00Z" })]);
    expect(await run("v1", "v2")).toMatchObject({ ok: false, kind: "not_found" });
    expect(await run("v1", "nope")).toMatchObject({ ok: false, kind: "not_found" });
  });

  it.each([["v1", "v1"], ["", "v2"], ["v1", ""]])("rejects base=%j target=%j without loading anything", async (base, target) => {
    const { run, fake } = setup();
    expect(await run(base, target)).toMatchObject({ ok: false, kind: "invalid" });
    expect(mocks.access).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it("only compares Word documents, recognising legacy rows by filename", async () => {
    const pdf = setup([version("v1", 1), version("v2", 2, { file_type: "pdf", filename: "MSA.pdf" })]);
    expect(await pdf.run("v1", "v2")).toEqual({ ok: false, kind: "invalid", detail: "Only Word (.docx) versions can be compared." });
    expect(mocks.downloadFile).not.toHaveBeenCalled();

    const legacy = setup([version("v1", 1, { file_type: null }), version("v2", 2, { file_type: null, filename: "MSA final.DOCX" })]);
    expect(await legacy.run("v1", "v2")).toMatchObject({ ok: true });
  });

  it("refuses an oversized version from its metadata, without downloading it", async () => {
    const { run, compare } = setup([version("v1", 1), version("v2", 2, { size_bytes: COMPARE_MAX_VERSION_BYTES + 1 })]);
    expect(await run("v1", "v2")).toMatchObject({ ok: false, kind: "too_large" });
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    expect(compare).not.toHaveBeenCalled();
  });

  it("refuses an oversized object even when its metadata understates the size", async () => {
    const { run, compare } = setup();
    mocks.downloadFile.mockResolvedValue(new ArrayBuffer(COMPARE_MAX_VERSION_BYTES + 1));
    expect(await run("v1", "v2")).toMatchObject({ ok: false, kind: "too_large" });
    expect(compare).not.toHaveBeenCalled();
  });

  it("reports missing stored bytes as not found", async () => {
    const { run, compare } = setup();
    mocks.downloadFile.mockImplementation(async (key: string) => key.includes("v2") ? null : new ArrayBuffer(4));
    expect(await run("v1", "v2")).toEqual({ ok: false, kind: "not_found", detail: "Document bytes not available" });
    expect(compare).not.toHaveBeenCalled();
  });

  it("maps a document the engine cannot read to 'unprocessable' without leaking the cause", async () => {
    const { run, compare } = setup();
    compare.mockRejectedValue(new DocxDiffError("The documents could not be compared.", { cause: new Error("zip offset 0x1f") }));
    expect(await run("v1", "v2")).toEqual({ ok: false, kind: "unprocessable", detail: "These versions could not be compared." });
  });

  it("lets an unexpected engine failure propagate so it is reported, not shown as a bad document", async () => {
    const { run, compare } = setup();
    compare.mockRejectedValue(new RangeError("WebAssembly memory exhausted"));
    await expect(run("v1", "v2")).rejects.toThrow("WebAssembly memory exhausted");
  });
});
