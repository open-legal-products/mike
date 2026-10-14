import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import type { DbJob } from "../../../lib/dbq/types";
const mocks = vi.hoisted(() => ({ download: vi.fn(), docx: vi.fn(), pdf: vi.fn(), convert: vi.fn(), sheet: vi.fn(), slides: vi.fn(), mammoth: vi.fn() }));
vi.mock("../../../lib/storage", () => ({ downloadFile: mocks.download }));
vi.mock("../../../lib/docxTrackedChanges", () => ({ extractDocxBodyText: mocks.docx }));
vi.mock("../../../lib/pdfText", () => ({ extractPdfTextForIndex: mocks.pdf }));
vi.mock("../../../lib/convert", () => ({ docxToPdf: mocks.convert }));
vi.mock("../../../lib/spreadsheet", () => ({ spreadsheetToLLMText: mocks.sheet }));
vi.mock("../../../lib/officeText", () => ({ extractPresentationText: mocks.slides }));
vi.mock("mammoth", () => ({ extractRawText: mocks.mammoth }));
import { extractDocumentText, handleDocumentExtractText, markDocumentTextFailed, backfillDocumentText, processDocumentTextInline } from "../documents.indexing";
const job = { id: "job", kind: "document.extract_text", payload: { versionId: "v1", revision: "r1" }, status: "pending", attempts: 0, max_attempts: 3, run_at: "", claimed_at: null, finished_at: null, last_error: null, dedupe_key: null, result: null, created_at: "" } satisfies DbJob;
const bytes = new TextEncoder().encode("source bytes").buffer;
const version = { id: "v1", storage_path: "source", file_type: "docx", text_revision: "r1" };
beforeEach(() => { vi.resetAllMocks(); mocks.download.mockResolvedValue(bytes); mocks.docx.mockResolvedValue("Complete clause\n\nAnother clause"); });
afterEach(() => vi.unstubAllEnvs());

describe("version text extraction", () => {
  it("publishes complete text against the revision and source hash, removing only unsupported NUL", async () => {
    mocks.docx.mockResolvedValue("Full\0 text\n" + "x".repeat(100000));
    const fake = scriptedDb([{ table: "document_versions", data: version }, { table: "document_version_texts", op: "update", data: { version_id: "v1" } }, { rpc: "publish_document_text", data: true }]);
    await handleDocumentExtractText(fake.db, job);
    expect(fake.calls[0].filters).toContainEqual(["eq", "text_revision", "r1"]);
    expect(fake.calls[2].args).toEqual({ p_version_id: "v1", p_revision: "r1", p_text: "Full text\n" + "x".repeat(100000), p_sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"), p_textless_pages: null });
    fake.done();
  });
  it("does not download superseded or deleted work", async () => {
    const fake = scriptedDb([{ table: "document_versions", data: null }]);
    await handleDocumentExtractText(fake.db, job); expect(mocks.download).not.toHaveBeenCalled(); fake.done();
  });
  it("skips an already-published revision", async () => {
    const fake = scriptedDb([{ table: "document_versions", data: version }, { table: "document_version_texts", op: "update", data: null }]);
    await handleDocumentExtractText(fake.db, job); expect(mocks.download).not.toHaveBeenCalled(); fake.done();
  });
  it("rejects source bytes that disagree with the persisted hash", async () => {
    const fake = scriptedDb([{ table: "document_versions", data: { ...version, content_sha256: "different" } }, { table: "document_version_texts", op: "update", data: { version_id: "v1" } }]);
    await expect(handleDocumentExtractText(fake.db, job)).rejects.toThrow("source_changed"); expect(mocks.docx).not.toHaveBeenCalled(); fake.done();
  });
  it("preserves successful empty extraction and OCR coverage", async () => {
    mocks.pdf.mockResolvedValue({ text: "", textlessPageCount: 4 });
    const fake = scriptedDb([{ table: "document_versions", data: { ...version, file_type: "pdf" } }, { table: "document_version_texts", op: "update", data: { version_id: "v1" } }, { rpc: "publish_document_text", data: true }]);
    await handleDocumentExtractText(fake.db, job);
    expect(fake.calls[2].args).toMatchObject({ p_text: "", p_textless_pages: 4 }); fake.done();
  });
  it("leaves a newer revision unchanged on terminal failure", async () => {
    const fake = scriptedDb([{ table: "document_version_texts", op: "update" }]);
    await markDocumentTextFailed(fake.db, job);
    expect(fake.calls[0].filters).toContainEqual(["eq", "source_revision", "r1"]);
    expect(fake.calls[0].payload).toMatchObject({ status: "failed", error_code: "extraction_failed" }); fake.done();
  });
  it("propagates extraction failure for queue retries", async () => {
    mocks.docx.mockRejectedValue(new Error("invalid document"));
    const fake = scriptedDb([{ table: "document_versions", data: version }, { table: "document_version_texts", op: "update", data: { version_id: "v1" } }]);
    await expect(handleDocumentExtractText(fake.db, job)).rejects.toThrow("invalid document"); fake.done();
  });
  it.each(["xlsx", "xlsm", "xls"])("uses the full spreadsheet reader for %s", async (type) => {
    mocks.sheet.mockReturnValue("Sheet and cell addresses");
    expect(await extractDocumentText(bytes, type)).toEqual({ text: "Sheet and cell addresses", textlessPageCount: null });
  });
  it.each(["doc", "ppt"])("converts legacy %s then uses strict PDF extraction", async (type) => {
    mocks.convert.mockResolvedValue(Buffer.from("pdf")); mocks.pdf.mockResolvedValue({ text: "Pages", textlessPageCount: 0 });
    expect(await extractDocumentText(bytes, type)).toEqual({ text: "Pages", textlessPageCount: 0 });
  });
  it("extracts slides and rejects unsupported formats", async () => {
    mocks.slides.mockResolvedValue("## Slide 1\nWords");
    expect((await extractDocumentText(bytes, "pptx")).text).toContain("Words");
    await expect(extractDocumentText(bytes, "exe")).rejects.toThrow("unsupported_format");
  });
  it("schedules a bounded resumable backfill with explicit failure retries", async () => {
    const fake = scriptedDb([{ rpc: "backfill_document_text", data: 3 }]);
    expect(await backfillDocumentText(fake.db, { limit: 25, retryFailed: true })).toBe(3);
    expect(fake.calls[0].args).toEqual({ p_limit: 25, p_retry_failed: true }); fake.done();
  });
  it("processes saved content inline when the queue runner is disabled", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const fake = scriptedDb([{ table: "db_jobs", data: [job] }, { table: "document_versions", data: version }, { table: "document_version_texts", op: "update", data: { version_id: "v1" } }, { rpc: "publish_document_text", data: true }, { table: "db_jobs", op: "update" }]);
    await processDocumentTextInline(fake.db, ["v1"]);
    expect(fake.calls[0].filters).toContainEqual(["in", "payload->>versionId", ["v1"]]);
    expect(fake.calls[4].payload).toMatchObject({ status: "done" }); fake.done();
  });
});
