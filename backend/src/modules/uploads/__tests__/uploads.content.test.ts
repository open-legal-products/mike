import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { validateDocumentContent } from "../uploads.content";

async function zipOf(files: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const name of files) zip.file(name, "<x/>");
  return await zip.generateAsync({ type: "uint8array" });
}

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

describe("validateDocumentContent", () => {
  it("accepts a PDF header and rejects other bytes", async () => {
    expect(await validateDocumentContent("pdf", bytes("%PDF-1.7\n..."))).toBe(true);
    expect(await validateDocumentContent("pdf", bytes("MZ\x90\x00 not a pdf"))).toBe(false);
    expect(await validateDocumentContent("pdf", new Uint8Array())).toBe(false);
  });

  it("accepts a DOCX package and rejects a plain ZIP", async () => {
    const docx = await zipOf(["[Content_Types].xml", "word/document.xml"]);
    expect(await validateDocumentContent("docx", docx)).toBe(true);

    const plainZip = await zipOf(["readme.txt"]);
    expect(await validateDocumentContent("docx", plainZip)).toBe(false);
  });

  it("rejects an OOXML package of the wrong kind", async () => {
    const xlsx = await zipOf(["[Content_Types].xml", "xl/workbook.xml"]);
    expect(await validateDocumentContent("docx", xlsx)).toBe(false);
    expect(await validateDocumentContent("xlsx", xlsx)).toBe(true);
    const pptx = await zipOf(["[Content_Types].xml", "ppt/presentation.xml"]);
    expect(await validateDocumentContent("pptx", pptx)).toBe(true);
  });

  it("rejects non-ZIP bytes and truncated archives claiming to be OOXML", async () => {
    expect(await validateDocumentContent("docx", bytes("%PDF-1.7"))).toBe(false);
    const docx = await zipOf(["[Content_Types].xml", "word/document.xml"]);
    expect(await validateDocumentContent("docx", docx.slice(0, 40))).toBe(false);
    expect(await validateDocumentContent("docx", new Uint8Array())).toBe(false);
  });

  it("checks the OLE signature for legacy Office types", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
    expect(await validateDocumentContent("doc", ole)).toBe(true);
    expect(await validateDocumentContent("xls", ole)).toBe(true);
    expect(await validateDocumentContent("doc", bytes("%PDF-1.7"))).toBe(false);
  });

  it("rejects unknown types", async () => {
    expect(await validateDocumentContent("exe", bytes("%PDF-1.7"))).toBe(false);
  });
});
