import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { normalizeDocxZipPaths } from "../convert";

async function docxWithBackslashEntry(
  content: (path: string) => { data: string | Buffer; size?: number },
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("word/document.xml", "<doc/>");
  zip.file("word\\styles.xml", content("word\\styles.xml").data);
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("normalizeDocxZipPaths", () => {
  it("rewrites backslash-separated entries to forward slashes", async () => {
    const input = await docxWithBackslashEntry(() => ({
      data: "<styles/>",
    }));
    const output = await normalizeDocxZipPaths(input);
    const zip = await JSZip.loadAsync(output);
    expect(zip.file("word/styles.xml")).toBeTruthy();
    expect(zip.file("word\\styles.xml")).toBeFalsy();
  });

  it("returns the original buffer untouched when no backslash paths exist", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", "<doc/>");
    const input = await zip.generateAsync({ type: "nodebuffer" });
    expect(await normalizeDocxZipPaths(input)).toBe(input);
  });

  it("abandons normalization (returns the original buffer) when an entry's decompressed size is over the cap", async () => {
    // Build a real large entry (just over the per-entry cap) compressed well
    // below the upload limit: highly compressible zeros.
    const zip = new JSZip();
    zip.file("word/document.xml", "<doc/>");
    zip.file(
      "word\\big.xml",
      Buffer.alloc(101 * 1024 * 1024 + 1, 0),
    );
    const input = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    expect(input.byteLength).toBeLessThan(100 * 1024 * 1024);
    const output = await normalizeDocxZipPaths(input);
    const reloaded = await JSZip.loadAsync(output);
    expect(reloaded.file("word\\big.xml")).toBeTruthy();
  });
});
