import { describe, expect, it } from "vitest";
import { extractPdfText, extractPdfTextForModel } from "../pdfText";

/** A one-page PDF reading "Hello reference"; pdf.js rebuilds its xref. */
function tinyPdf(): ArrayBuffer {
  const stream = "BT /F1 12 Tf 20 100 Td (Hello reference) Tj ET";
  const source = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${stream.length} >> stream`,
    stream,
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return new TextEncoder().encode(source).buffer as ArrayBuffer;
}

describe("PDF text extraction", () => {
  it.each([
    ["for the model", extractPdfTextForModel],
    ["as plain text", extractPdfText],
  ])("reads the text %s without emptying the caller's bytes", async (_label, extract) => {
    const bytes = tinyPdf();
    const size = bytes.byteLength;
    expect(await extract(bytes)).toContain("Hello reference");
    // pdf.js detaches a buffer it is handed; callers still need theirs,
    // for example to store a playbook reference once its text is read.
    expect(bytes.byteLength).toBe(size);
    expect(new Uint8Array(bytes)[0]).toBe("%".charCodeAt(0));
  });
});
