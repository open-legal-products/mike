import { describe, expect, it, vi } from "vitest";
import type { ExternalSource } from "../../../../lib/sourceDocuments";

// A synthetic provider that verifies tolerantly, beside the real registry.
vi.mock("../../../source-documents/sourceDocuments.service", async (original) => {
  const actual = await original<typeof import("../../../source-documents/sourceDocuments.service")>();
  const tolerant = { id: "tolerant", quoteVerification: "fuzzy" as const };
  return {
    ...actual,
    sourceProviderFor: (id: string) => (id.startsWith("tolerant:") ? tolerant : actual.sourceProviderFor(id)),
    isExternalSourceDocumentId: (id: string) => id.startsWith("tolerant:") || actual.isExternalSourceDocumentId(id),
  };
});

import { createCitation, parseCitations } from "../citations";
import { caseCitationEventFromRecord } from "../tools/courtlistenerTurnState";
import {
  externalSourceCitationHint,
  externalSourceReference,
  registerExternalSource,
} from "../tools/externalSources";
import type { DocIndex, DocStore } from "../types";

const TEXT = "The court held that notice was sufficient. The appeal is dismissed.";

function source(overrides: Partial<ExternalSource["document"]> = {}): ExternalSource {
  return {
    text: TEXT,
    document: {
      document_id: "prov:abc",
      title: "Smith v Jones",
      type: "case",
      metadata: [],
      quotes: [],
      actions: [{ type: "link", url: "https://example.com/smith" }],
      subdocuments: [
        { document_id: "prov:abc:text", title: "Smith v Jones", type: "html" },
      ],
      ...overrides,
    },
  };
}

function cite(block: string) {
  return parseCitations(`<CITATIONS>${block}</CITATIONS>`)[0];
}

describe("registerExternalSource", () => {
  it("takes the next free handle and reuses it for the same provider document", () => {
    const docIndex: DocIndex = {
      "doc-0": { document_id: "11111111-1111-1111-1111-111111111111", filename: "Brief.pdf" },
    };
    const docStore: DocStore = new Map([
      ["doc-0", { storage_path: "p", file_type: "pdf", filename: "Brief.pdf" }],
    ]);
    const handle = registerExternalSource(source(), docIndex, docStore);
    expect(handle).toBe("doc-1");
    expect(docIndex["doc-1"]).toEqual({ document_id: "prov:abc", filename: "Smith v Jones" });
    expect(docStore.get("doc-1")).toMatchObject({
      inline_text: TEXT,
      external_source: { document_id: "prov:abc" },
      storage_path: "",
    });

    const again = registerExternalSource(
      { ...source(), text: `${TEXT} Amended.` },
      docIndex,
      docStore,
    );
    expect(again).toBe("doc-1");
    expect(docStore.get("doc-1")?.inline_text).toBe(`${TEXT} Amended.`);
    expect(Object.keys(docIndex)).toEqual(["doc-0", "doc-1"]);
  });

  it("tells the model the handle and, when cut off, to read the rest first", () => {
    expect(externalSourceCitationHint(["doc-3"], false)).toContain('doc_id "doc-3"');
    expect(externalSourceCitationHint(["doc-3"], false)).not.toContain("read_document");
    expect(externalSourceCitationHint(["doc-3"], true)).toContain('Call read_document with doc_id "doc-3"');
  });

  it("names several sources' handles in the order the result lists them", () => {
    const hint = externalSourceCitationHint(["doc-3", "doc-4", "doc-5"], false);
    expect(hint).toContain('3 complete source documents, available in this chat as doc_id "doc-3", "doc-4" and "doc-5", in the order they appear above');
    expect(hint).not.toContain("read_document");
    expect(externalSourceCitationHint(["doc-3", "doc-4"], true)).toContain("Call read_document with a document's doc_id");
  });
});

describe("externalSourceReference", () => {
  it("keeps one source's reference in its established shape", () => {
    expect(JSON.parse(externalSourceReference([{ document: source().document, handle: "doc-1" }]))).toEqual({
      ok: true,
      external_source: { document_id: "prov:abc", title: "Smith v Jones", doc_id: "doc-1", note: expect.any(String) },
    });
  });

  it("keeps every source's reference, and no text, for a result that carried several", () => {
    const second = source({ document_id: "prov:def", title: "Jones v Smith" }).document;
    const stored = externalSourceReference([{ document: source().document }, { document: second, handle: "doc-2" }]);
    expect(stored).not.toContain(TEXT);
    expect(JSON.parse(stored)).toEqual({
      ok: true,
      external_sources: [
        { document_id: "prov:abc", title: "Smith v Jones" },
        { document_id: "prov:def", title: "Jones v Smith", doc_id: "doc-2" },
      ],
      note: expect.any(String),
    });
  });
});

describe("createCitation for an external source", () => {
  function registered() {
    const docIndex: DocIndex = {};
    const docStore: DocStore = new Map();
    const handle = registerExternalSource(source(), docIndex, docStore);
    return { docIndex, docStore, handle };
  }

  it("verifies verbatim quotes and carries the provider document without its text", () => {
    const { docIndex, docStore, handle } = registered();
    const citation = createCitation(
      cite(`[{"ref":1,"doc_id":"${handle}","page":1,"quote":"notice was sufficient"}]`),
      docIndex,
      undefined,
      docStore,
    );
    expect(citation).toMatchObject({
      kind: "document",
      ref: 1,
      doc_id: handle,
      document_id: "prov:abc",
      filename: "Smith v Jones",
      verified: true,
      version_id: null,
      document: {
        document_id: "prov:abc",
        type: "case",
        quotes: [
          {
            quote: "notice was sufficient",
            verification: { verified: true },
            target: { subdocument_id: "prov:abc:text" },
          },
        ],
      },
    });
    expect(JSON.stringify(citation)).not.toContain(TEXT);
  });

  it("drops a citation whose quote is not in the canonical text", () => {
    const { docIndex, docStore, handle } = registered();
    expect(
      createCitation(
        cite(`[{"ref":1,"doc_id":"${handle}","page":1,"quote":"notice was insufficient"}]`),
        docIndex,
        undefined,
        docStore,
      ),
    ).toBeNull();
    expect(
      createCitation(
        cite(`[{"ref":1,"doc_id":"${handle}","page":1,"quote":"  "}]`),
        docIndex,
        undefined,
        docStore,
      ),
    ).toBeNull();
  });

  it("resolves the source by title or provider id, but not an ambiguous title", () => {
    const { docIndex, docStore } = registered();
    for (const id of ["Smith v Jones", "prov:abc"]) {
      expect(
        createCitation(
          cite(`[{"ref":1,"doc_id":"${id}","page":1,"quote":"The appeal is dismissed."}]`),
          docIndex,
          undefined,
          docStore,
        ),
      ).toMatchObject({ doc_id: "doc-0", document_id: "prov:abc", verified: true });
    }
    registerExternalSource(
      source({ document_id: "prov:def", subdocuments: [{ document_id: "prov:def:text", title: "Smith v Jones", type: "html" }] }),
      docIndex,
      docStore,
    );
    expect(
      createCitation(
        cite(`[{"ref":1,"doc_id":"Smith v Jones","page":1,"quote":"The appeal is dismissed."}]`),
        docIndex,
        undefined,
        docStore,
      ),
    ).toBeNull();
  });

  it("leaves a tolerant provider's quotes to end-of-turn verification, unverified until then", () => {
    const docIndex: DocIndex = {};
    const docStore: DocStore = new Map();
    const handle = registerExternalSource(
      source({ document_id: "tolerant:1", subdocuments: [{ document_id: "tolerant:1:text", title: "Smith v Jones", type: "html" }] }),
      docIndex,
      docStore,
    );
    const drifted = createCitation(
      cite(`[{"ref":1,"doc_id":"${handle}","page":1,"quote":"notice  was sufficient"}]`),
      docIndex,
      undefined,
      docStore,
    );
    // Not dropped at creation, but never stored as verified by a turn that
    // ends before verification runs.
    expect(drifted).toMatchObject({
      doc_id: handle,
      document_id: "tolerant:1",
      verified: false,
      document: { quotes: [{ quote: "notice  was sufficient", verification: { verified: false } }] },
    });
  });

  it("stamps the case documents the engine emits as events", () => {
    const event = caseCitationEventFromRecord({
      clusterId: 77,
      caseName: "A v B",
      citations: ["1 U.S. 1"],
      url: "https://www.courtlistener.com/opinion/77/a-v-b/",
      pdfUrl: null,
      dateFiled: null,
      opinions: [],
    });
    expect(event?.document).toMatchObject({ document_id: "case:77", provider: "courtlistener", quote_verification: "fuzzy" });
  });

  it("stamps a CourtListener case citation with its provider", () => {
    const citation = createCitation(
      cite(`[{"ref":1,"kind":"case","cluster_id":77,"quotes":[{"quote":"Held","opinionId":1}]}]`),
      {},
      new Map([[77, { caseName: "A v B", citations: ["1 U.S. 1"], url: null, pdfUrl: null, dateFiled: null }]]),
    );
    expect(citation).toMatchObject({
      kind: "case",
      document: { document_id: "case:77", provider: "courtlistener", quote_verification: "fuzzy" },
    });
  });

  it("leaves uploaded-document citations on their existing path", () => {
    const docIndex: DocIndex = {
      "doc-0": { document_id: "11111111-1111-1111-1111-111111111111", filename: "Brief.pdf", version_id: "v1", version_number: 1 },
    };
    const docStore: DocStore = new Map([
      ["doc-0", { storage_path: "p", file_type: "pdf", filename: "Brief.pdf" }],
    ]);
    expect(
      createCitation(
        cite(`[{"ref":1,"doc_id":"doc-0","page":2,"quote":"anything"}]`),
        docIndex,
        undefined,
        docStore,
      ),
    ).toMatchObject({ kind: "document", document_id: "11111111-1111-1111-1111-111111111111", page: 2, version_id: "v1" });
  });
});
