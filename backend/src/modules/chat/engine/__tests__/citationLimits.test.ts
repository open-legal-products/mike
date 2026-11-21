import { describe, expect, it } from "vitest";
import { parseCitations, parsePartialCitationObjects, limitCitationPayload } from "../citations";
import { extractCitations } from "../contextBuilders";
import type { DocStore } from "../types";

const citations = Array.from({ length: 51 }, (_, i) => ({ ref: i + 1, doc_id: "doc-0", quote: "Exact text" }));
const json = JSON.stringify(citations);
describe("bounded citation payloads", () => {
  it("caps final and partial parsed citations at 50", () => {
    expect(parseCitations(`<CITATIONS>${json}</CITATIONS>`)).toHaveLength(50);
    expect(parsePartialCitationObjects(json.slice(0, -1))).toHaveLength(50);
  });
  it("measures serialized UTF-8 bytes including escaping and array separators", () => {
    const entries = [{ text: "é".repeat(2_499_987) }, { text: "too large" }, { text: "" }];
    const limited = limitCitationPayload(entries);
    expect(limited).toEqual([entries[0], entries[2]]);
    expect(Buffer.byteLength(JSON.stringify(limited))).toBeLessThanOrEqual(5_000_000);
    expect(limitCitationPayload([{ text: "\u0000".repeat(1_000_000) }, { ref: 2 }])).toEqual([{ ref: 2 }]);
  });
  it("skips unserializable entries", () => {
    const circular: Record<string, unknown> = {}; circular.self = circular;
    expect(limitCitationPayload([undefined, circular, { ref: 1 }])).toEqual([{ ref: 1 }]);
  });
  it("never carries an external source's body in fallback extraction", () => {
    const body = "Exact text" + "é".repeat(900_000);
    const docStore: DocStore = new Map([["doc-0", {
      storage_path: "", file_type: "text/plain", filename: "Law",
      inline_text: body,
      external_source: { document_id: "mcp:c1:2:uk:3:abc", title: "Law", type: "legislation", metadata: [], quotes: [],
        subdocuments: [{ document_id: "mcp:c1:2:uk:3:abc:text", title: "Law", type: "html" }],
      },
    }]]);
    const result = extractCitations(`<CITATIONS>${json}</CITATIONS>`, {}, docStore);
    // Verified against the full text, but only the reference leaves the turn:
    // the panel reads the body again when the source opens.
    expect(result).toHaveLength(50);
    expect(JSON.stringify(result)).not.toContain("é".repeat(100));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(100_000);
  });
});

describe("citation cap", () => {
  it("counts valid citations, so invalid entries cannot crowd out a valid one", () => {
    const invalid = Array.from({ length: 50 }, (_, i) => ({ ref: i + 1 }));
    const valid = { ref: 51, doc_id: "doc-0", quote: "Exact text" };
    const parsed = parseCitations(`<CITATIONS>${JSON.stringify([...invalid, valid])}</CITATIONS>`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ ref: 51, doc_id: "doc-0" });
  });
});
