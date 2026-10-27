import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../../lib/supabase";

const mocks = vi.hoisted(() => ({
  runPython: vi.fn(),
  loadCurrentVersionBytes: vi.fn(),
  readStoredDocumentText: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  limits: {} as Record<string, number>,
}));

vi.mock("../../../../../lib/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../lib/sandbox")>();
  return {
    ...actual,
    getSandbox: () => ({ runPython: mocks.runPython }),
    sandboxLimits: () => ({ ...actual.sandboxLimits(), ...mocks.limits }),
  };
});
vi.mock("../../../../../lib/storage", () => ({
  downloadFile: mocks.downloadFile,
  uploadFile: mocks.uploadFile,
  generatedDocKey: (userId: string, docId: string, filename: string) => `generated/${userId}/${docId}/${filename}`,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../../../lib/downloadTokens", () => ({ buildDownloadUrl: () => "/download/test-token" }));
vi.mock("../../../../documents/documents.service", () => ({
  applyTrackedEditsToDocument: vi.fn(),
  createDocumentVersion: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
  loadCurrentVersionBytes: mocks.loadCurrentVersionBytes,
  readStoredDocumentText: mocks.readStoredDocumentText,
  saveVisualVersion: vi.fn(),
}));
vi.mock("../../../../../lib/pdfText", () => ({
  extractPdfTextForModel: vi.fn(async () => "Clause 5: minimum purchases"),
  extractPdfText: vi.fn(),
  extractLegacyOfficeText: vi.fn(),
}));

import * as XLSX from "xlsx";
import { createChildPythonTurnState, createPythonTurnState, runPythonToolCall, type PythonToolContext } from "../pythonTools";

const xlsxBytes = () => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["region", "revenue"], ["north", 10]]), "Sales");
  return Buffer.from(XLSX.write(book, { type: "buffer", bookType: "xlsx" }));
};

function fakeDb() {
  return {
    from(table: string) {
      const query: Record<string, unknown> = {};
      query.insert = vi.fn(() => query);
      query.select = vi.fn(() => query);
      query.eq = vi.fn(() => query);
      query.single = vi.fn(async () => ({ data: { id: table === "documents" ? "doc-new" : "version-1" }, error: null }));
      return query;
    },
  } as unknown as Db;
}

function context(overrides: Partial<PythonToolContext> = {}): PythonToolContext {
  return {
    state: createPythonTurnState(),
    docStore: new Map([
      ["doc-1", { storage_path: "documents/u1/x/source.xlsx", file_type: "xlsx", filename: "sales-2026.xlsx" }],
      ["doc-2", { storage_path: "documents/u1/y/source.pdf", file_type: "pdf", filename: "distribution-agreement.pdf" }],
    ]),
    docIndex: {
      "doc-1": { document_id: "xlsx-id", filename: "sales-2026.xlsx", version_id: "xv1", version_number: 1 },
      "doc-2": { document_id: "pdf-id", filename: "distribution-agreement.pdf", version_id: "pv1", version_number: 1 },
    },
    db: fakeDb(),
    userId: "u1",
    allowSave: true,
    nonce: "nonce1",
    write: vi.fn(),
    ...overrides,
  };
}

const run = (input: Record<string, unknown>, ctx = context()) =>
  runPythonToolCall({ id: "call-9", function: { name: "run_python", arguments: JSON.stringify(input) } }, input, ctx);
const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, stdout: "done", stdoutTruncated: false, outputs: [], durationMs: 5, ...extra });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.limits = {};
  mocks.loadCurrentVersionBytes.mockImplementation(async (documentId: string) =>
    documentId === "xlsx-id"
      ? { bytes: xlsxBytes(), storage_path: "documents/u1/x/source.xlsx" }
      : { bytes: Buffer.from("%PDF-1.4"), storage_path: "documents/u1/y/source.pdf" },
  );
  mocks.runPython.mockResolvedValue(ok());
});

describe("run_python", () => {
  it("rejects a document that is not in the conversation and lists the ones that are", async () => {
    const result = await run({ description: "x", code: "print(1)", doc_ids: ["doc-7"] });

    expect(JSON.parse(result.content)).toMatchObject({ ok: false, error: expect.stringContaining("doc-1, doc-2") });
    expect(mocks.runPython).not.toHaveBeenCalled();
  });

  it("mounts a chat spreadsheet as a file and a pdf as text, and fences the result by run_id", async () => {
    mocks.runPython.mockResolvedValue(ok({ result: { total: 15 } }));
    const ctx = context();

    const { content, event } = await run({ description: "Totals", code: "x", doc_ids: ["doc-1", "doc-2"] }, ctx);

    const docs = mocks.runPython.mock.calls[0][0].docs;
    expect(docs[0]).toMatchObject({ doc_id: "doc-1", file_type: "xlsx", bytes: expect.stringMatching(/^UEsDB/) });
    expect(docs[1]).toMatchObject({ doc_id: "doc-2", file_type: "pdf", text: "Clause 5: minimum purchases" });
    expect(docs[1].bytes).toBeUndefined();
    expect(content).toMatch(/^<untrusted-content nonce="nonce1">/);
    expect(JSON.parse(content.split("\n")[1])).toMatchObject({ ok: true, run_id: "call-9", result: { total: 15 }, mounted: ["doc-1", "doc-2"] });
    expect(ctx.state.results.get("call-9")).toEqual({
      result: { total: 15 },
      documents: [
        { document_id: "xlsx-id", version_id: "xv1", filename: "sales-2026.xlsx" },
        { document_id: "pdf-id", version_id: "pv1", filename: "distribution-agreement.pdf" },
      ],
    });
    expect(event).toMatchObject({ type: "python_run", run_id: "call-9", status: "completed", stdout: "done", documents: [{ filename: "sales-2026.xlsx" }, { filename: "distribution-agreement.pdf" }] });
  });

  it("fails a document over the remaining input budget as invalid_input, not unavailable", async () => {
    mocks.limits = { maxInputBytes: 10 };

    const result = await run({ description: "x", code: "x", doc_ids: ["doc-2"] });

    expect(JSON.parse(result.content)).toMatchObject({ ok: false, error_code: "invalid_input", error: expect.stringContaining("fewer documents") });
    expect(mocks.runPython).not.toHaveBeenCalled();
  });

  it("does not mount a search result whose revision has moved on", async () => {
    mocks.readStoredDocumentText.mockResolvedValue({ revision: "r2", status: "ready", text: "new" });
    const ctx = context({
      docStore: new Map([["doc-3", { storage_path: "", file_type: "pdf", filename: "found.pdf", search_source: { revision: "r1", userId: "u1" } }]]),
      docIndex: { "doc-3": { document_id: "f", filename: "found.pdf", version_id: "fv", version_number: 1 } },
    });

    const result = await run({ description: "x", code: "x", doc_ids: ["doc-3"] }, ctx);

    expect(JSON.parse(result.content)).toMatchObject({ ok: false, error: expect.stringContaining("could not be read") });
    expect(mocks.runPython).not.toHaveBeenCalled();
  });

  it("turns saved rows into a spreadsheet with numbers as numbers and text as text, and saves nothing for a read-only caller", async () => {
    const outputs = [{ name: "Summary.xlsx", columns: ["total"], rows: [[12.5], ["-5%"]] }];
    mocks.runPython.mockResolvedValue(ok({ outputs }));

    const saved = await run({ description: "x", code: "x" });
    expect(saved.created).toEqual([expect.objectContaining({ filename: "Summary.xlsx", document_id: "doc-new" })]);
    const sheet = await (await import("jszip")).default.loadAsync(mocks.uploadFile.mock.calls[0][1] as ArrayBuffer);
    const xml = await sheet.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(xml).toContain('<c r="A2"><v>12.5</v></c>');
    expect(xml).toContain("<t>-5%</t>");

    const readOnly = await run({ description: "x", code: "x" }, context({ allowSave: false }));
    expect(readOnly.created).toEqual([]);
    expect(JSON.parse(readOnly.content.split("\n")[1])).toMatchObject({ files_saved: [], note: expect.stringContaining("not saved") });
  });

  it("stops after 25 runs in one answer, and subagents share one pool of their own", async () => {
    const ctx = context();
    for (let i = 0; i < 25; i++) await run({ description: "x", code: "x" }, ctx);
    const next = await run({ description: "x", code: "x" }, ctx);
    expect(JSON.parse(next.content)).toMatchObject({ ok: false, error: expect.stringContaining("limit") });
    expect(mocks.runPython).toHaveBeenCalledTimes(25);

    const parent = createPythonTurnState();
    const child = createChildPythonTurnState(parent);
    expect(parent.budgets).toHaveLength(1);
    expect(child.budgets.map((b) => b.limit)).toEqual([25, 50]);
    expect(createChildPythonTurnState(parent).budgets[1]).toBe(child.budgets[1]);
  });

  it("gives the model a preview of a large result and keeps the whole of it for visuals", async () => {
    const breaches = Array.from({ length: 1200 }, (_, i) => ({ row: i, fee: 12.5, note: "fee above the agreed cap" }));
    mocks.runPython.mockResolvedValue(ok({ result: { total: 15_000, breaches } }));
    const ctx = context();

    const { content } = await run({ description: "Audit", code: "x" }, ctx);

    const body = JSON.parse(content.split("\n")[1]);
    expect(body.result).toBeUndefined();
    expect(body.result_preview).toEqual({ total: 15_000, breaches: [...breaches.slice(0, 3), "1197 more items"] });
    expect(body.result_note).toContain("stored as run_id call-9");
    expect(ctx.state.results.get("call-9")?.result).toEqual({ total: 15_000, breaches });
  });

  it("cuts a preview that is itself too large", async () => {
    const nested = ([width, ...rest]: number[]): unknown =>
      Object.fromEntries(Array.from({ length: width }, (_, i) => [`k${i}`, rest.length ? nested(rest) : "v"]));
    mocks.runPython.mockResolvedValue(ok({ result: nested([25, 10, 12, 6]) }));

    const { content } = await run({ description: "x", code: "x" });

    const body = JSON.parse(content.split("\n")[1]);
    expect(body.result_preview).toMatch(/^.{20000}\.\.\.$/s);
  });

  it("maps sandbox failures to fixed sentences and keeps the traceback for a python error", async () => {
    mocks.runPython.mockResolvedValueOnce({ ok: false, code: "python_error", traceback: 'File "<exec>", line 1\nZeroDivisionError', stdout: "partial" });
    const error = await run({ description: "x", code: "1/0" });
    expect(JSON.parse(error.content)).toMatchObject({ ok: false, error_code: "python_error", error: expect.stringContaining("ZeroDivisionError"), stdout: "partial" });

    mocks.runPython.mockResolvedValueOnce({ ok: false, code: "unavailable" });
    const unavailable = await run({ description: "x", code: "x" });
    expect(JSON.parse(unavailable.content)).toMatchObject({ ok: false, error_code: "unavailable", instruction: expect.stringContaining("Do not call run_python again") });
    expect(unavailable.event).toMatchObject({ status: "failed", error_code: "unavailable" });
  });
});
