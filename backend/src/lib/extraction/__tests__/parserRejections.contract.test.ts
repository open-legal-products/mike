// The byte-rejection allowlist (failure.ts) matches pdf.js class names and
// JSZip / mammoth messages. failure.test.ts builds those shapes by hand, so
// if a library rewords a message or renames a class, every unit test stays
// green while corrupt uploads silently go back to three attempts and three
// events. This file sends REAL corrupt bytes through the unmocked
// extractDocumentText and the installed libraries, so such a change fails
// here first.

import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { extractDocumentText } from "../documentText";
import { isByteRejection } from "../failure";

const bytes = (value: string | Uint8Array): ArrayBuffer =>
  Uint8Array.from(typeof value === "string" ? Buffer.from(value) : value).buffer;

async function zip(files: Record<string, string>): Promise<Uint8Array> {
  const archive = new JSZip();
  for (const [name, content] of Object.entries(files)) archive.file(name, content);
  return archive.generateAsync({ type: "uint8array" });
}

/** A real OOXML-shaped archive cut short: its central directory is gone. */
async function truncatedZip(): Promise<Uint8Array> {
  const whole = await zip({
    "[Content_Types].xml": "<Types/>",
    "word/document.xml": "<w:document><w:body><w:p/></w:body></w:document>",
  });
  return whole.subarray(0, Math.floor(whole.length / 2));
}

async function rejectionOf(raw: ArrayBuffer, fileType: string): Promise<unknown> {
  return extractDocumentText(raw, fileType).then(
    () => expect.unreachable(`${fileType} bytes should be rejected`),
    (error: unknown) => error,
  );
}

describe("real parsers reject corrupt bytes in a shape isByteRejection recognises", () => {
  it.each([
    ["docx", "not a ZIP", async () => bytes("this is plain text, not a zip container")],
    ["docx", "a truncated ZIP", truncatedZip],
    ["docx", "a ZIP with no word/document.xml", () => zip({ "readme.txt": "hello" })],
    ["pptx", "not a ZIP", async () => bytes("this is plain text, not a zip container")],
    ["pptx", "a truncated ZIP", truncatedZip],
    ["pdf", "a header with no PDF behind it", async () => bytes("%PDF-1.7\nnot really a pdf")],
    ["pdf", "an empty file", async () => new Uint8Array(0)],
  ] as const)("%s: %s", async (fileType, _label, build) => {
    const raw = await build();
    const error = await rejectionOf(raw instanceof ArrayBuffer ? raw : bytes(raw), fileType);
    expect(isByteRejection(error)).toBe(true);
  }, 20_000);
});
