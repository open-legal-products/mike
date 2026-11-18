import { describe, expect, it } from "vitest";
import { isPanelDocument, panelDocumentFromCitation, type DocumentCitation } from "./types";

it("recognizes embedded legal research documents from the citation stream", () => {
    expect(isPanelDocument({ document_id: "mcp:source", title: "Doctrine", type: "legal_research", metadata: [], quotes: [] })).toBe(true);
});

describe("panelDocumentFromCitation", () => {
    it("preserves quote verification for legacy document citations", () => {
        const citation: DocumentCitation = {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "document-1",
            document_id: "document-1",
            filename: "agreement.docx",
            page: 3,
            quote: "Unmatched quote",
            quotes: [
                {
                    page: 3,
                    quote: "Unmatched quote",
                    verification: { verified: false },
                },
            ],
        };

        expect(panelDocumentFromCitation(citation).quotes[0]).toMatchObject({
            quote: "Unmatched quote",
            verification: { verified: false },
            target: { page: 3 },
        });
    });

    it("reconciles verified top-level quotes into an older normalized document", () => {
        const citation: DocumentCitation = {
            type: "citation_data",
            kind: "document",
            ref: 1,
            doc_id: "document-1",
            document_id: "document-1",
            filename: "agreement.docx",
            page: 3,
            quote: "Corrected source quote",
            quotes: [
                {
                    page: 3,
                    quote: "Corrected source quote",
                    verification: { verified: true },
                },
            ],
            document: {
                document_id: "document-1",
                title: "agreement.docx",
                type: "docx",
                metadata: [],
                quotes: [
                    {
                        quote: "Drifted model quote",
                        target: { page: 3 },
                    },
                ],
            },
        };

        expect(panelDocumentFromCitation(citation).quotes[0]).toMatchObject({
            quote: "Corrected source quote",
            verification: { verified: true },
            target: { page: 3 },
        });
    });
});
