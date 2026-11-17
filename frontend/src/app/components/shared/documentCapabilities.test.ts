import { describe, expect, it } from "vitest";
import {
    documentCapabilities,
    isExternalSourceType,
    legalSourceIconKind,
} from "./documentCapabilities";
import type { PanelDocument } from "./types";

function document(overrides: Partial<PanelDocument>): PanelDocument {
    return {
        document_id: "doc",
        title: "Title",
        type: "docx",
        metadata: [],
        quotes: [],
        ...overrides,
    };
}

describe("documentCapabilities", () => {
    it("treats uploads as versioned files without a legal icon", () => {
        expect(documentCapabilities(document({ type: "pdf" }))).toEqual({
            external: false,
            hydrateOnOpen: false,
            exactQuotes: false,
            legalIcon: null,
        });
        expect(isExternalSourceType("spreadsheet")).toBe(false);
        expect(legalSourceIconKind(undefined)).toBeNull();
    });

    it("treats case law, legislation and legal research as external sources with their icons", () => {
        expect(documentCapabilities(document({ type: "case" }))).toEqual({
            external: true,
            hydrateOnOpen: true,
            exactQuotes: false,
            legalIcon: "case",
        });
        expect(documentCapabilities(document({ type: "legislation" })).legalIcon).toBe(
            "legislation",
        );
        // Legal research (doctrine, commentary) shares the legislation glyph.
        expect(documentCapabilities(document({ type: "legal_research" }))).toEqual({
            external: true,
            hydrateOnOpen: true,
            exactQuotes: false,
            legalIcon: "legislation",
        });
        expect(isExternalSourceType("legislation")).toBe(true);
    });

    it("reads origin and quote exactness from the provider's stamp on the wire", () => {
        // A provider document of a file type is still a provider document.
        const stamped = document({ type: "pdf", provider: "some_provider", quote_verification: "exact" });
        expect(documentCapabilities(stamped)).toEqual({
            external: true,
            hydrateOnOpen: true,
            exactQuotes: true,
            legalIcon: null,
        });
        expect(
            documentCapabilities(
                document({ type: "case", provider: "courtlistener", quote_verification: "fuzzy" }),
            ).exactQuotes,
        ).toBe(false);
    });

    it("hydrates an external source only until it has a body", () => {
        const withoutBody = document({
            type: "case",
            subdocuments: [{ document_id: "s", title: "Lead", type: "html" }],
        });
        expect(documentCapabilities(withoutBody).hydrateOnOpen).toBe(true);
        const withHtml = document({
            type: "case",
            subdocuments: [{ document_id: "s", title: "Lead", type: "html", html: "<p>x</p>" }],
        });
        expect(documentCapabilities(withHtml).hydrateOnOpen).toBe(false);
        const withText = document({
            type: "legislation",
            subdocuments: [{ document_id: "s", title: "Act", type: "html", text: "Section 1" }],
        });
        expect(documentCapabilities(withText).hydrateOnOpen).toBe(false);
    });
});
