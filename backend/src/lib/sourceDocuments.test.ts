import { describe, expect, it } from "vitest";
import {
  caseClusterId,
  caseDocumentId,
  normalizeCaseDocument,
} from "./sourceDocuments";

describe("normalized source documents", () => {
  it("keeps the provider locator behind one opaque document ID", () => {
    expect(caseDocumentId(123)).toBe("case:123");
    expect(caseClusterId("case:123")).toBe(123);
    expect(caseClusterId("document:123")).toBeNull();
  });

  it("normalizes case metadata, actions, opinions, and quote targets", () => {
    const document = normalizeCaseDocument({
      clusterId: 123,
      caseName: "Example v Example",
      citation: "123 U.S. 456",
      dateFiled: "2024-01-02",
      url: "https://example.com/source",
      pdfUrl: "https://example.com/source.pdf",
      opinions: [
        {
          opinionId: 2,
          type: "dissent",
          author: "Judge D",
          html: "<p>Dissent</p>",
        },
        {
          opinionId: 1,
          type: "lead",
          author: "Judge L",
          html: "<p>Lead</p>",
        },
      ],
      quotes: [
        {
          opinionId: 2,
          quote: "Quoted dissent",
          verification: { verified: true, start_char: 3, end_char: 18 },
        },
      ],
    });

    expect(document).toMatchObject({
      document_id: "case:123",
      title: "Example v Example, 123 U.S. 456",
      type: "case",
      metadata: [{ label: "Date", value: "2024-01-02", format: "date" }],
      quotes: [
        {
          quote: "Quoted dissent",
          verification: { verified: true, start_char: 3, end_char: 18 },
          target: { subdocument_id: "case:123:opinion:2" },
        },
      ],
    });
    expect(document.actions).toEqual([
      {
        type: "download",
        url: "https://example.com/source.pdf",
      },
      {
        type: "link",
        url: "https://example.com/source",
      },
    ]);
    expect(document.subdocuments?.map((item) => item.title)).toEqual([
      "Lead Opinion by Judge L",
      "Dissent by Judge D",
    ]);
  });
});
