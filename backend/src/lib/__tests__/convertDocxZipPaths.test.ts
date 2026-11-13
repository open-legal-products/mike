import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { normalizeDocxZipPaths } from "../convert";

const MB = 1024 * 1024;
// Compresses to a few KB. The size only needs to dwarf the archive: a real
// bomb is the same shape scaled up until inflating it exhausts the heap.
const BOMB_BYTES = 8 * MB;

async function archive(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Overwrite the uncompressed size every header claims for `name`. */
function forgeUncompressedSize(input: Buffer, name: string, claimed: number): Buffer {
  const out = Buffer.from(input);
  const bytes = Buffer.from(name, "latin1");
  for (let at = 0; at + 46 < out.length; at++) {
    const signature = out.readUInt32LE(at);
    if (signature === 0x04034b50 && out.subarray(at + 30, at + 30 + bytes.length).equals(bytes)) {
      out.writeUInt32LE(claimed, at + 22);
    } else if (signature === 0x02014b50 && out.subarray(at + 46, at + 46 + bytes.length).equals(bytes)) {
      out.writeUInt32LE(claimed, at + 24);
    }
  }
  return out;
}

/**
 * The output must be the input with only backslashes in names turned into
 * slashes: same length, same compressed data, nothing inflated or re-encoded.
 */
function expectRenamedInPlace(input: Buffer, output: Buffer) {
  expect(output.length).toBe(input.length);
  for (let at = 0; at < input.length; at++) {
    if (input[at] !== output[at]) {
      expect([input[at], output[at]]).toEqual([0x5c, 0x2f]);
    }
  }
}

async function entryNames(buffer: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buffer);
  return Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
}

describe("normalizeDocxZipPaths", () => {
  it("renames backslash entries of an ordinary DOCX and keeps their content", async () => {
    const document = "<w:document><w:body><w:p/></w:body></w:document>";
    const input = await archive({
      "[Content_Types].xml": "<Types/>",
      "_rels\\.rels": "<Relationships/>",
      "word\\document.xml": document,
    });

    const output = await normalizeDocxZipPaths(input);

    expect(await entryNames(output)).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    const zip = await JSZip.loadAsync(output);
    expect(await zip.file("word/document.xml")!.async("string")).toBe(document);
  });

  it("renames a backslash bomb entry without inflating it", async () => {
    const input = await archive({
      "[Content_Types].xml": "<Types/>",
      "word\\document.xml": Buffer.alloc(BOMB_BYTES, 0x20),
    });

    const output = await normalizeDocxZipPaths(input);

    expectRenamedInPlace(input, output);
    expect(await entryNames(output)).toEqual(["[Content_Types].xml", "word/document.xml"]);
  });

  it("renames a bomb entry whose headers understate its size, without trusting them", async () => {
    const honest = await archive({
      "[Content_Types].xml": "<Types/>",
      "word\\document.xml": Buffer.alloc(BOMB_BYTES, 0x20),
    });
    const input = forgeUncompressedSize(honest, "word\\document.xml", 1000);

    const output = await normalizeDocxZipPaths(input);

    expectRenamedInPlace(input, output);
    expect(await entryNames(output)).toEqual(["[Content_Types].xml", "word/document.xml"]);
  });

  it("leaves a forward-slash bomb entry compressed while renaming a sibling", async () => {
    const input = await archive({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml": Buffer.alloc(BOMB_BYTES, 0x20),
      "word\\styles.xml": "<w:styles/>",
    });

    const output = await normalizeDocxZipPaths(input);

    expectRenamedInPlace(input, output);
    expect(await entryNames(output)).toEqual(["[Content_Types].xml", "word/document.xml", "word/styles.xml"]);
  });
});
