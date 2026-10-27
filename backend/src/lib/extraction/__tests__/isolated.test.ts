import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
  EXTRACTION_MAX_BYTES,
  ExtractionLimitError,
  runIsolatedExtraction,
} from "../isolated";

// These run the real worker thread (vitest.config turns isolation off for
// every other suite).
beforeEach(() => vi.stubEnv("EXTRACTION_ISOLATION", "on"));

/** A copy of the module with no worker yet, so a test sees a cold start. */
async function freshModule() {
  vi.resetModules();
  return import("../isolated.js");
}
afterEach(() => vi.unstubAllEnvs());

function workbook(): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["Item", "Amount"], ["Rent", 1200]]),
    "Budget",
  );
  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return Uint8Array.from(buffer).buffer;
}

function onePagePdf(): ArrayBuffer {
  const content = "BT /F1 12 Tf 72 720 Td (Case No. 24CV-1234) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Uint8Array.from(Buffer.from(pdf, "binary")).buffer;
}

describe("runIsolatedExtraction", () => {
  it("parses on the worker thread and returns the parser's result", async () => {
    const text = await runIsolatedExtraction("spreadsheet", workbook());
    expect(text).toContain("## Sheet: Budget");
    expect(text).toContain("| 2 | Rent | 1200 |");
  });

  // pdfjs loads its own fake worker; it must still work inside this thread.
  it("reads a PDF on the worker thread", async () => {
    await expect(runIsolatedExtraction("pdfForModel", onePagePdf())).resolves.toContain("Case No. 24CV-1234");
    await expect(
      runIsolatedExtraction("documentText", onePagePdf(), { fileType: "pdf" }),
    ).resolves.toMatchObject({ text: expect.stringContaining("24CV-1234"), textlessPageCount: 0 });
  });

  it("passes a parser's own failure through as an ordinary error", async () => {
    const failure = runIsolatedExtraction("documentText", workbook(), {
      fileType: "exe",
    });
    await expect(failure).rejects.toThrow("document_text_unsupported_format");
    await expect(failure).rejects.not.toBeInstanceOf(ExtractionLimitError);
  });

  // A cold worker takes far longer than 1 ms just to load the parsers.
  it("stops a parse that runs past the timeout, then recovers on a fresh worker", async () => {
    const isolated = await freshModule();
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "1");
    await expect(
      isolated.runIsolatedExtraction("spreadsheet", workbook()),
    ).rejects.toBeInstanceOf(isolated.ExtractionLimitError);
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "60000");
    await expect(
      isolated.runIsolatedExtraction("spreadsheet", workbook()),
    ).resolves.toContain("Rent");
  });

  it("stops a parse that runs out of memory, then recovers on a fresh worker", async () => {
    const isolated = await freshModule();
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "4");
    await expect(
      isolated.runIsolatedExtraction("spreadsheet", workbook()),
    ).rejects.toBeInstanceOf(isolated.ExtractionLimitError);
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "1024");
    await expect(
      isolated.runIsolatedExtraction("spreadsheet", workbook()),
    ).resolves.toContain("Rent");
  });

  it("serves an interactive read ahead of queued background work", async () => {
    const order: string[] = [];
    const track = (label: string, run: Promise<unknown>) =>
      run.then(() => void order.push(label));
    await Promise.all([
      track("first", runIsolatedExtraction("spreadsheet", workbook())),
      track("background", runIsolatedExtraction("spreadsheet", workbook())),
      track(
        "interactive",
        runIsolatedExtraction("spreadsheet", workbook(), { interactive: true }),
      ),
    ]);
    expect(order).toEqual(["first", "interactive", "background"]);
  });

  it("refuses a file over the size backstop without starting a parse", async () => {
    await expect(
      runIsolatedExtraction(
        "spreadsheet",
        new ArrayBuffer(EXTRACTION_MAX_BYTES + 1),
      ),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
  });
});
