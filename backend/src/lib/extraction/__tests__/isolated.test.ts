import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  EXTRACTION_MAX_BYTES,
  ExtractionLimitError,
  runIsolatedExtraction,
  stopExtractionProcess,
} from "../isolated";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

beforeEach(() => {
  vi.mocked(spawn).mockClear();
  vi.stubEnv("EXTRACTION_ISOLATION", "on");
});
afterEach(async () => { await stopExtractionProcess(); vi.unstubAllEnvs(); });

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
  it("parses on the parser process and returns the parser's result", async () => {
    const text = await runIsolatedExtraction("spreadsheet", async () => workbook());
    expect(text).toContain("## Sheet: Budget");
    expect(text).toContain("| 2 | Rent | 1200 |");
  });

  it("reuses a warm process and recycles it after 200 files", async () => {
    const source = workbook();
    for (let index = 0; index < 200; index++) {
      await expect(runIsolatedExtraction("spreadsheet", async () => source)).resolves.toContain("Rent");
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(runIsolatedExtraction("spreadsheet", async () => source)).resolves.toContain("Rent");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  // pdfjs must load successfully inside the parser subprocess.
  it("reads a PDF on the parser process", async () => {
    await expect(runIsolatedExtraction("pdfForModel", async () => onePagePdf())).resolves.toContain("Case No. 24CV-1234");
    await expect(
      runIsolatedExtraction("documentText", async () => onePagePdf(), { fileType: "pdf" }),
    ).resolves.toMatchObject({ text: expect.stringContaining("24CV-1234"), textlessPageCount: 0 });
  });

  it.skipIf(!existsSync("/usr/bin/soffice"))("converts Office content using real LibreOffice inside the bounded process", async () => {
    const doc = new Document({ sections: [{ children: [new Paragraph("Synthetic lease clause 721")] }] });
    const buffer = await Packer.toBuffer(doc);
    // Repeated conversions must work inside the same bounded parser.
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(runIsolatedExtraction("legacyOfficeText", async () => Uint8Array.from(buffer).buffer)).resolves.toContain("Synthetic lease clause 721");
    }
  });

  it("passes a parser's own failure through as an ordinary error", async () => {
    const failure = runIsolatedExtraction("documentText", async () => workbook(), {
      fileType: "exe",
    });
    await expect(failure).rejects.toThrow("document_text_unsupported_format");
    await expect(failure).rejects.not.toBeInstanceOf(ExtractionLimitError);
  });

  // A cold process takes far longer than 1 ms just to load the parsers.
  it("stops a parse that runs past the timeout, then recovers on a fresh process", async () => {
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "1");
    await expect(
      runIsolatedExtraction("spreadsheet", async () => workbook()),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "60000");
    await expect(
      runIsolatedExtraction("spreadsheet", async () => workbook()),
    ).resolves.toContain("Rent");
  });

  it("stops a parse that runs out of memory, then recovers on a fresh process", async () => {
    // Linux refuses startup via its OS limit. Heap-only platforms need enough
    // memory to start V8 and reach its OOM handler instead of crashing Node.
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", process.platform === "linux" ? "4" : "16");
    await expect(
      runIsolatedExtraction("spreadsheet", async () => workbook()),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
    vi.stubEnv("EXTRACTION_MAX_MEMORY_MB", "1024");
    await expect(
      runIsolatedExtraction("spreadsheet", async () => workbook()),
    ).resolves.toContain("Rent");
  });

  it("rejects excessive UTF-8 output from a small compressed file and recovers", async () => {
    const zip = new JSZip();
    // Six million characters, but eighteen MiB of UTF-8 output.
    zip.file("ppt/slides/slide1.xml", `<a:t>${"€".repeat(6 * 1024 * 1024)}</a:t>`);
    const compressed = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(compressed.byteLength).toBeLessThan(100_000);
    await expect(runIsolatedExtraction("presentation", async () => Uint8Array.from(compressed).buffer)).rejects.toBeInstanceOf(ExtractionLimitError);
    await expect(runIsolatedExtraction("spreadsheet", async () => workbook())).resolves.toContain("Rent");
  });

  it("refuses a file over the size backstop without starting a parse", async () => {
    await expect(
      runIsolatedExtraction(
        "spreadsheet",
        async () => new ArrayBuffer(EXTRACTION_MAX_BYTES + 1),
      ),
    ).rejects.toBeInstanceOf(ExtractionLimitError);
  });
});
