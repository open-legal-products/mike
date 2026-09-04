import { describe, expect, it, vi } from "vitest";
import type { Citation, PanelDocument } from "../shared/types";
import {
    legalSourceDocumentFromCitation,
    resolvePanelDocumentVersion,
} from "./panelDocumentVersion";

const document: PanelDocument = {
    document_id: "document-1",
    title: "agreement.docx",
    type: "docx",
    metadata: [],
    quotes: [],
    version_id: null,
    version_number: null,
};

describe("resolvePanelDocumentVersion", () => {
    it("resolves an unversioned panel link to the current version", async () => {
        const loadVersions = vi.fn().mockResolvedValue({
            current_version_id: "version-3",
            versions: [
                {
                    id: "version-3",
                    version_number: 3,
                    source: "assistant_edit",
                    created_at: "2026-08-18T00:00:00Z",
                    filename: "agreement.docx",
                },
            ],
        });

        await expect(
            resolvePanelDocumentVersion(document, loadVersions),
        ).resolves.toMatchObject({
            version_id: "version-3",
            version_number: 3,
        });
    });

    it("resolves a known version number instead of substituting current", async () => {
        const loadVersions = vi.fn().mockResolvedValue({
            current_version_id: "version-3",
            versions: [
                {
                    id: "version-2",
                    version_number: 2,
                    source: "assistant_edit",
                    created_at: "2026-08-17T00:00:00Z",
                    filename: "agreement.docx",
                },
                {
                    id: "version-3",
                    version_number: 3,
                    source: "assistant_edit",
                    created_at: "2026-08-18T00:00:00Z",
                    filename: "agreement.docx",
                },
            ],
        });

        await expect(
            resolvePanelDocumentVersion(
                { ...document, version_number: 2 },
                loadVersions,
            ),
        ).resolves.toMatchObject({
            version_id: "version-2",
            version_number: 2,
        });
    });

    it("does not resolve external legislation through internal document versions", async () => {
        const loadVersions = vi.fn();
        const legislation: PanelDocument = {
            document_id: "legal-data-hunter:legislation:LEGIARTI000001",
            title: "Code civil, article 1103",
            type: "legislation",
            metadata: [],
            quotes: [],
            subdocuments: [
                {
                    document_id:
                        "legal-data-hunter:legislation:LEGIARTI000001:text",
                    title: "Code civil, article 1103",
                    type: "html",
                    text: "Les contrats légalement formés tiennent lieu de loi.",
                },
            ],
        };

        await expect(
            resolvePanelDocumentVersion(legislation, loadVersions),
        ).resolves.toBe(legislation);
        expect(loadVersions).not.toHaveBeenCalled();
    });
});

describe("legalSourceDocumentFromCitation", () => {
    it.each(["case", "legislation"] as const)(
        "returns a normalized %s document for the legal-source panel",
        (type) => {
            const legalDocument: PanelDocument = {
                document_id: `legal-data-hunter:${type}:1`,
                title: type === "case" ? "Example v Example" : "Article 1103",
                type,
                metadata: [],
                quotes: [],
                subdocuments: [
                    {
                        document_id: `legal-data-hunter:${type}:1:text`,
                        title: "Canonical text",
                        type: "html",
                        text: "Canonical legal text.",
                    },
                ],
            };
            const citation = {
                kind: "document",
                document: legalDocument,
            } as Citation;

            expect(legalSourceDocumentFromCitation(citation)).toBe(legalDocument);
        },
    );

    it("does not route internal documents or CourtListener case citations through the LDH panel path", () => {
        expect(
            legalSourceDocumentFromCitation({
                kind: "document",
                document: { ...document, type: "pdf" },
            } as Citation),
        ).toBeNull();
        expect(
            legalSourceDocumentFromCitation({ kind: "case" } as Citation),
        ).toBeNull();
    });
});
