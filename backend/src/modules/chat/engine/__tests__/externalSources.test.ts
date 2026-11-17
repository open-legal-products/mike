import { describe, expect, it } from "vitest";
import type { ExternalSource } from "../../../../lib/sourceDocuments";
import { createCitation, parseCitations } from "../citations";
import {
  externalSourceCitationHint,
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
      actions: [{ type: "link", url: "https://example.com/smith", label: "Link" }],
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
    expect(externalSourceCitationHint("doc-3", false)).toContain('doc_id "doc-3"');
    expect(externalSourceCitationHint("doc-3", false)).not.toContain("read_document");
    expect(externalSourceCitationHint("doc-3", true)).toContain("read_document");
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
