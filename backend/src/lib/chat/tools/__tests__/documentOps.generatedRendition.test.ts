import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ConversionJobData } from "../../../queue/conversionQueue";

// persistGeneratedFile (exercised through generatePpt) is where a generated
// PPTX pays for LibreOffice. These tests pin the flag contract:
//   - flag off  → inline conversion, exactly as before the queue existed
//   - flag on   → no inline LibreOffice; the rendition rides the conversion
//                 queue, keyed on the new versionId, finalize: false
//   - flag on + enqueue failure → degrade to "usable document, no rendition"
//                 (the sync path's historical conversion-failure behavior)

// Each stub carries the signature of the function it replaces, so the
// assertions below can read `mock.calls[n][m]` as the real argument type
// instead of an untyped tuple.
const uploadFile =
  vi.fn<(key: string, content: ArrayBuffer, contentType: string) => Promise<void>>(
    async () => {},
  );
vi.mock("../../../storage", () => ({
  uploadFile: (key: string, content: ArrayBuffer, contentType: string) =>
    uploadFile(key, content, contentType),
  downloadFile: vi.fn(async () => null),
  generatedDocKey: (userId: string, docId: string, filename: string) =>
    `generated/${userId}/${docId}/${filename}`,
}));

const docxToPdf = vi.fn<(buffer: Buffer) => Promise<Buffer>>(async () =>
  Buffer.from("pdf-bytes"),
);
vi.mock("../../../convert", () => ({
  docxToPdf: (buffer: Buffer) => docxToPdf(buffer),
  convertedPdfKey: (userId: string, docId: string) =>
    `converted-pdfs/${userId}/${docId}.pdf`,
}));

const enqueueConversion = vi.fn<(data: ConversionJobData) => Promise<unknown>>(
  async () => ({}),
);
vi.mock("../../../queue/conversionQueue", () => ({
  enqueueConversion: (data: ConversionJobData) => enqueueConversion(data),
}));

vi.mock("../../../downloadTokens", () => ({
  buildDownloadUrl: (key: string) => `https://dl.test/${key}`,
}));

vi.mock("../../../supabase", () => ({
  createServerSupabase: vi.fn(),
}));

import { generatePpt } from "../documentOps";

type Insert = { table: string; payload: Record<string, unknown> };

// Chainable Supabase double: records inserts, returns fixed ids.
function makeDb() {
  const inserts: Insert[] = [];
  function from(table: string) {
    const b: Record<string, unknown> = {
      insert(payload: Record<string, unknown>) {
        inserts.push({ table, payload });
        return b;
      },
      update() {
        return b;
      },
      select() {
        return b;
      },
      eq() {
        return b;
      },
      single() {
        return Promise.resolve({
          data: { id: table === "documents" ? "doc-db-1" : "ver-db-1" },
          error: null,
        });
      },
      then(onF: (v: unknown) => unknown) {
        return Promise.resolve({ data: null, error: null }).then(onF);
      },
    };
    return b;
  }
  return { inserts, from };
}

const SLIDES = [{ title: "One", bullets: ["a"] }];

beforeEach(() => {
  uploadFile.mockClear();
  docxToPdf.mockClear();
  enqueueConversion.mockClear();
});

afterEach(() => {
  delete process.env.ASYNC_DOCUMENT_CONVERSION;
});

describe("generatePpt rendition path", () => {
  it("flag off: converts inline and stores the rendition on the version", async () => {
    process.env.ASYNC_DOCUMENT_CONVERSION = "false";
    const db = makeDb();

    const out = await generatePpt("Deck", SLIDES, "user-1", db as never);

    expect(out).not.toHaveProperty("error");
    expect(docxToPdf).toHaveBeenCalledTimes(1);
    expect(enqueueConversion).not.toHaveBeenCalled();
    const version = db.inserts.find((i) => i.table === "document_versions");
    expect(version?.payload.pdf_storage_path).toMatch(/^converted-pdfs\//);
  });

  it("flag on: skips LibreOffice and enqueues a conversion for the new version", async () => {
    process.env.ASYNC_DOCUMENT_CONVERSION = "true";
    const db = makeDb();

    const out = await generatePpt("Deck", SLIDES, "user-1", db as never);

    expect(out).not.toHaveProperty("error");
    expect(docxToPdf).not.toHaveBeenCalled();
    // The document row is inserted without a rendition; the job fills it in.
    const version = db.inserts.find((i) => i.table === "document_versions");
    expect(version?.payload.pdf_storage_path).toBeNull();
    expect(enqueueConversion).toHaveBeenCalledTimes(1);
    const job = enqueueConversion.mock.calls[0][0];
    expect(job).toMatchObject({
      documentId: "doc-db-1",
      versionId: "ver-db-1",
      userId: "user-1",
      fileType: "pptx",
      // The generated doc was inserted "ready" and is downloadable from its
      // raw bytes — a rendition failure must never flip it to "error".
      finalizeDocumentStatus: false,
    });
    expect(job.pdfKey).toBe("converted-pdfs/user-1/doc-db-1.pdf");
  });

  it("flag on: a failed enqueue degrades to a usable document with no rendition", async () => {
    process.env.ASYNC_DOCUMENT_CONVERSION = "true";
    enqueueConversion.mockRejectedValueOnce(new Error("redis down"));
    const db = makeDb();

    const out = await generatePpt("Deck", SLIDES, "user-1", db as never);

    expect(out).not.toHaveProperty("error");
    expect(out).toHaveProperty("document_id", "doc-db-1");
  });

  it("never converts or enqueues for spreadsheets (xlsx is served raw)", async () => {
    process.env.ASYNC_DOCUMENT_CONVERSION = "true";
    const db = makeDb();
    const { generateExcel } = await import("../documentOps.js");

    const out = await generateExcel("Book", [], "user-1", db as never);

    expect(out).not.toHaveProperty("error");
    expect(docxToPdf).not.toHaveBeenCalled();
    expect(enqueueConversion).not.toHaveBeenCalled();
  });
});
