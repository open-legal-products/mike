import { describe, expect, it } from "vitest";
import { parseCitations, parsePartialCitationObjects, limitCitationPayload, withoutEmbeddedSourceText } from "../citations";
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
  it("bounds hydrated citation bodies in fallback extraction", () => {
    const docStore: DocStore = new Map([["doc-0", {
      storage_path: "", file_type: "text/plain", filename: "Law",
      inline_text: "Exact text",
      panel_document: { document_id: "source", title: "Law", type: "legislation", metadata: [], quotes: [],
        subdocuments: [{ document_id: "source:text", title: "Law", type: "html", text: "Exact text" + "é".repeat(900_000) }],
      },
    }]]);
    const result = extractCitations(`<CITATIONS>${json}</CITATIONS>`, {}, docStore);
    expect(result).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(5_000_000);
  });
});

describe("embedded source text leaving the turn", () => {
  it("drops only mcp: source bodies and keeps their references", () => {
    const embedded = {
      kind: "document", doc_id: "doc-2", verified: true,
      document: {
        document_id: "mcp:c1:2:uk:3:abc", title: "R v X", type: "case", metadata: [],
        quotes: [{ quote: "Held", target: { subdocument_id: "mcp:c1:2:uk:3:abc:text" } }],
        actions: [{ type: "link", url: "https://example.com/judgment" }],
        subdocuments: [{ document_id: "mcp:c1:2:uk:3:abc:text", title: "R v X", type: "html", text: "Held, the appeal is allowed." }],
      },
    };
    const uploaded = { kind: "document", doc_id: "doc-0", filename: "a.pdf", document: { document_id: "uuid-1", subdocuments: [{ document_id: "s", text: "kept" }] } };
    const kase = { kind: "case", cluster_id: 1, quotes: [] };
    const [stripped, untouchedUpload, untouchedCase] = withoutEmbeddedSourceText([embedded, uploaded, kase]) as typeof embedded[];
    expect(stripped.document.subdocuments).toEqual([{ document_id: "mcp:c1:2:uk:3:abc:text", title: "R v X", type: "html" }]);
    expect(stripped.document.quotes).toEqual(embedded.document.quotes);
    expect(stripped.document.actions).toEqual(embedded.document.actions);
    expect(untouchedUpload).toBe(uploaded);
    expect(untouchedCase).toBe(kase);
    expect(embedded.document.subdocuments[0].text).toBe("Held, the appeal is allowed.");
  });
});
