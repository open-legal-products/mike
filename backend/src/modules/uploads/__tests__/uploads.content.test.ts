import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";

import {
  readZipEntryNames,
  validateDocumentContent,
  type ReadRange,
} from "../uploads.content";

async function zipOf(
  files: string[],
  comment?: string,
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const name of files) zip.file(name, "<x/>");
  return await zip.generateAsync({ type: "uint8array", comment });
}

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "latin1"));

// A reader over an in-memory buffer that, like object storage, serves only the
// requested inclusive range. Recording the ranges lets tests assert that the
// whole object is never read.
function readerOf(data: Uint8Array) {
  const read = vi.fn<ReadRange>(async (start, end) =>
    data.slice(start, end + 1),
  );
  return { read, size: data.length };
}

async function valid(fileType: string, data: Uint8Array) {
  const { read, size } = readerOf(data);
  return await validateDocumentContent(fileType, size, read);
}

describe("validateDocumentContent", () => {
  it("accepts a PDF header and rejects other bytes", async () => {
    expect(await valid("pdf", bytes("%PDF-1.7\n..."))).toBe(true);
    expect(await valid("pdf", bytes("MZ\x90\x00 not a pdf"))).toBe(false);
    expect(await valid("pdf", new Uint8Array())).toBe(false);
  });

  it("accepts a DOCX package and rejects a plain ZIP", async () => {
    const docx = await zipOf(["[Content_Types].xml", "word/document.xml"]);
    expect(await valid("docx", docx)).toBe(true);
    expect(await valid("docx", await zipOf(["readme.txt"]))).toBe(false);
  });

  it("rejects an OOXML package of the wrong kind", async () => {
    const xlsx = await zipOf(["[Content_Types].xml", "xl/workbook.xml"]);
    expect(await valid("docx", xlsx)).toBe(false);
    expect(await valid("xlsx", xlsx)).toBe(true);
    const pptx = await zipOf(["[Content_Types].xml", "ppt/presentation.xml"]);
    expect(await valid("pptx", pptx)).toBe(true);
  });

  it("rejects non-ZIP, empty, and truncated input claiming to be OOXML", async () => {
    const docx = await zipOf(["[Content_Types].xml", "word/document.xml"]);
    expect(await valid("docx", bytes("%PDF-1.7 padding padding"))).toBe(false);
    expect(await valid("docx", new Uint8Array())).toBe(false);
    expect(await valid("docx", docx.slice(0, 40))).toBe(false);
    expect(await valid("docx", docx.slice(0, docx.length - 10))).toBe(false);
  });

  it("checks the OLE signature for legacy Office types", async () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]);
    expect(await valid("doc", ole)).toBe(true);
    expect(await valid("xls", ole)).toBe(true);
    expect(await valid("doc", bytes("%PDF-1.7"))).toBe(false);
  });

  it("rejects unknown types", async () => {
    expect(await valid("exe", bytes("%PDF-1.7"))).toBe(false);
  });

  it("never reads the whole object", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<x/>");
    zip.file("word/document.xml", "<x/>");
    // Incompressible payload so the archive really is large.
    zip.file("word/media/big.bin", Buffer.alloc(3 * 1024 * 1024, 7), {
      compression: "STORE",
    });
    const data = await zip.generateAsync({ type: "uint8array" });
    const { read, size } = readerOf(data);

    expect(await validateDocumentContent("docx", size, read)).toBe(true);
    for (const [start, end] of read.mock.calls) {
      expect(end - start + 1).toBeLessThan(size / 4);
    }
  });
});

describe("readZipEntryNames", () => {
  it("lists entry names without decompressing", async () => {
    const data = await zipOf(["a.txt", "dir/b.xml"]);
    const { read, size } = readerOf(data);
    expect(await readZipEntryNames(size, read)).toEqual(
      new Set(["a.txt", "dir/", "dir/b.xml"]),
    );
  });

  it("finds the end record behind an archive comment", async () => {
    const data = await zipOf(["a.txt"], "x".repeat(5000));
    const { read, size } = readerOf(data);
    expect(await readZipEntryNames(size, read)).toEqual(new Set(["a.txt"]));
  });

  it("is not fooled by an end-record signature inside the comment", async () => {
    const fake = Buffer.from([0x50, 0x4b, 0x05, 0x06]).toString("latin1");
    const data = await zipOf(["a.txt"], `${fake}${"\0".repeat(30)}`);
    const { read, size } = readerOf(data);
    expect(await readZipEntryNames(size, read)).toEqual(new Set(["a.txt"]));
  });

  it("rejects a directory that points outside the file", async () => {
    const data = Buffer.from(await zipOf(["a.txt"]));
    const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    data.writeUInt32LE(data.length + 100, end + 16);
    const { read, size } = readerOf(data);
    expect(await readZipEntryNames(size, read)).toBeNull();
  });

  it("propagates storage read failures instead of judging the file", async () => {
    const data = await zipOf(["a.txt"]);
    const read: ReadRange = async () => {
      throw new Error("storage down");
    };
    await expect(readZipEntryNames(data.length, read)).rejects.toThrow(
      "storage down",
    );
  });
});
