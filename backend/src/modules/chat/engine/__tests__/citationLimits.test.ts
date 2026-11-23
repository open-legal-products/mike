import { describe, expect, it } from "vitest";
import { limitCitationPayload, MAX_CITATIONS } from "../citations";
import { createCitationRecorder, documentCitations } from "../citeSources";
import type { DocStore } from "../types";

const entries = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => ({
    ref: from + i,
    doc_id: "doc-0",
    quotes: [{ quote: "Exact text" }],
  }));

function recorder(docStore: DocStore, text = "Exact text") {
  return createCitationRecorder(
    documentCitations({
      docIndex: {},
      docStore,
      casesByClusterId: new Map(),
      readSourceText: async () => text,
      getCaseOpinions: async () => [],
    }),
  );
}

const lease: DocStore = new Map([
  ["doc-0", { storage_path: "", file_type: "txt", filename: "Lease.txt", inline_text: "Exact text" }],
]);

describe("bounded citation payloads", () => {
  it(`records at most ${MAX_CITATIONS} citations per answer, across calls`, async () => {
    const rec = recorder(lease);
    await rec.record({ citations: entries(40) });
    const result = JSON.parse((await rec.record({ citations: entries(11, 41) })).content);
    expect(rec.citations()).toHaveLength(MAX_CITATIONS);
    expect(result.rejected).toEqual([
      { ref: 51, error: `An answer can cite at most ${MAX_CITATIONS} entries.` },
    ]);
    // A ref already recorded is replaced, not counted again.
    await rec.record({ citations: entries(1, 50) });
    expect(rec.citations()).toHaveLength(MAX_CITATIONS);
  });

  it("measures serialized UTF-8 bytes including escaping and array separators", () => {
    const rows = [{ text: "é".repeat(2_499_987) }, { text: "too large" }, { text: "" }];
    const limited = limitCitationPayload(rows);
    expect(limited).toEqual([rows[0], rows[2]]);
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(5_000_000);
    expect(limitCitationPayload([{ text: "\u0000".repeat(1_000_000) }, { ref: 2 }])).toEqual([{ ref: 2 }]);
  });

  it("skips unserializable entries", () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(limitCitationPayload([undefined, circular, { ref: 1 }])).toEqual([{ ref: 1 }]);
  });

  it("never carries an external source's body in a recorded citation", async () => {
    const body = "Exact text" + "é".repeat(900_000);
    const docStore: DocStore = new Map([["doc-0", {
      storage_path: "", file_type: "text/plain", filename: "Law",
      inline_text: body,
      external_source: { document_id: "mcp:c1:2:uk:3:abc", title: "Law", type: "legislation", metadata: [], quotes: [],
        subdocuments: [{ document_id: "mcp:c1:2:uk:3:abc:text", title: "Law", type: "html" }],
      },
    }]]);
    const rec = recorder(docStore, body);
    await rec.record({ citations: entries(MAX_CITATIONS) });
    const result = rec.citations();
    // Verified against the full text, but only the reference leaves the turn:
    // the panel reads the body again when the source opens.
    expect(result).toHaveLength(MAX_CITATIONS);
    expect(JSON.stringify(result)).not.toContain("é".repeat(100));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100_000);
  });
});

describe("citation cap", () => {
  it("counts valid citations, so invalid entries cannot crowd out a valid one", async () => {
    const rec = recorder(lease);
    const invalid = Array.from({ length: MAX_CITATIONS }, (_, i) => ({ ref: i + 1 }));
    await rec.record({ citations: [...invalid, ...entries(1, 51)] });
    expect(rec.citations()).toHaveLength(1);
    expect(rec.citations()[0]).toMatchObject({ ref: 51, doc_id: "doc-0" });
  });
});
