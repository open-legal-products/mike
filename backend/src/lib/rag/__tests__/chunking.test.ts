import { describe, expect, it } from "vitest";
import { chunkDocumentText } from "../chunking";

describe("chunkDocumentText", () => {
  it("keeps page ranges and exact offsets for page-marked text", () => {
    const text = "[Page 1]\nArt. 1 Oggetto del contratto.\n\n[Page 2]\nArt. 2 Clausola compromissoria: ogni controversia è deferita ad arbitri.";
    const chunks = chunkDocumentText(text, { chunkChars: 400, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ pageStart: 1, pageEnd: 2 });
    expect(text.slice(chunks[0]!.startChar, chunks[0]!.endChar)).toContain("Clausola compromissoria");
    expect(chunks[0]!.content).not.toContain("[Page");
  });

  it("splits long text into bounded overlapping chunks", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragrafo ${i} ` + "parola ".repeat(40));
    const text = paragraphs.join("\n\n");
    const chunks = chunkDocumentText(text, { chunkChars: 800, overlap: 300 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.endChar - c.startChar).toBeLessThanOrEqual(800);
    expect(chunks[1]!.startChar).toBeLessThan(chunks[0]!.endChar);
    expect(chunks.every((c) => c.pageStart === null)).toBe(true);
  });

  it("hard-splits a single oversized paragraph and respects maxChunks", () => {
    const chunks = chunkDocumentText("x ".repeat(5000), { chunkChars: 500, overlap: 0, maxChunks: 3 });
    expect(chunks).toHaveLength(3);
  });
});

describe("chunkDocumentText overlap across hard cuts", () => {
  it("keeps overlap between the pieces of a hard-split paragraph", () => {
    const chunks = chunkDocumentText("x".repeat(1200), { chunkChars: 400, overlap: 100 });
    expect(chunks.length).toBeGreaterThan(3);
    for (let k = 1; k < chunks.length; k++) {
      expect(chunks[k]!.startChar).toBeLessThan(chunks[k - 1]!.endChar);
    }
    expect(chunks[chunks.length - 1]!.endChar).toBe(1200);
  });
});
