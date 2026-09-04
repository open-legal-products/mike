import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocPanel, DocumentTitleRow } from "./DocPanel";

describe("DocumentTitleRow", () => {
    it("uses the shared compact title row with a file-type icon", () => {
        const { container } = render(
            <DocumentTitleRow
                document={{
                    document_id: "document-1",
                    title: "agreement.docx",
                    type: "docx",
                    metadata: [],
                    quotes: [],
                    version_id: "version-1",
                    version_number: 1,
                }}
                isReloading={false}
                compactActions={false}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "agreement.docx",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");
        expect(
            container.querySelector('img[src*="/icons/file-types/word.svg"]'),
        ).toBeInTheDocument();
    });

    it("uses pill-height source actions when the side panel is minimized", () => {
        render(
            <DocumentTitleRow
                document={{
                    document_id: "case:123",
                    title: "Example v Example",
                    type: "case",
                    metadata: [],
                    quotes: [],
                    actions: [
                        {
                            type: "download",
                            url: "https://example.com/opinion.pdf",
                            label: "Download",
                        },
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "Source",
                        },
                    ],
                }}
                isReloading={false}
                compactActions
            />,
        );

        expect(screen.getByRole("link", { name: "Download" })).toHaveClass(
            "h-6",
            "w-6",
        );
        expect(screen.getByRole("link", { name: "Source" })).toHaveClass(
            "h-6",
            "w-6",
        );
    });
});

describe("case document", () => {
    it("uses the same title row for normalized metadata and actions", () => {
        const { container } = render(
            <DocPanel
                compactActions={false}
                mode={{ kind: "document" }}
                document={{
                    document_id: "case:123",
                    title: "Example v Example, [2024] UKSC 1",
                    type: "case",
                    metadata: [
                        {
                            label: "Date",
                            value: "2024-01-02",
                            format: "date",
                        },
                    ],
                    actions: [
                        {
                            type: "download",
                            url: "https://example.com/opinion.pdf",
                            label: "Download",
                        },
                        {
                            type: "link",
                            url: "https://example.com/source",
                            label: "Link",
                        },
                    ],
                    quotes: [],
                    subdocuments: [
                        {
                            document_id: "case:123:opinion:456",
                            title: "Lead Opinion by Justice Example",
                            type: "html",
                            html: "<p>Opinion text.</p>",
                            text: null,
                        },
                    ],
                }}
            />,
        );

        const title = screen.getByRole("heading", {
            name: "Example v Example, [2024] UKSC 1",
        });
        expect(title).toHaveClass("text-sm", "font-medium");
        expect(title).not.toHaveClass("font-serif");

        const metadata = screen.getByText("Date: January 2, 2024");
        expect(metadata.parentElement).toHaveClass("w-full");
        expect(metadata.parentElement).not.toBe(title.parentElement);

        expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
            "href",
            "https://example.com/opinion.pdf",
        );
        expect(screen.getByRole("link", { name: "Link" })).toHaveAttribute(
            "href",
            "https://example.com/source",
        );
        expect(
            container.querySelector(
                'img[src*="/icons/legal-sources/case-law.svg"]',
            ),
        ).toHaveClass("h-4", "w-4");
        expect(screen.getByText("Opinion text.")).toBeInTheDocument();
    });
});

describe("legislation document", () => {
    it("renders canonical text in the legal-source viewer without an internal PDF", () => {
        const { container } = render(
            <DocPanel
                compactActions={false}
                mode={{ kind: "document" }}
                document={{
                    document_id: "mcp:connector-1:legislation:article-1103",
                    title: "Code civil, article 1103",
                    type: "legislation",
                    metadata: [
                        { label: "Citation", value: "Article 1103" },
                    ],
                    actions: [
                        {
                            type: "link",
                            url: "https://www.legifrance.gouv.fr/example",
                            label: "Official source",
                        },
                    ],
                    quotes: [],
                    subdocuments: [
                        {
                            document_id:
                                "mcp:connector-1:legislation:article-1103:text",
                            title: "Code civil, article 1103",
                            type: "html",
                            text: "Les contrats légalement formés tiennent lieu de loi.",
                        },
                    ],
                }}
            />,
        );

        expect(
            screen.getByText(
                "Les contrats légalement formés tiennent lieu de loi.",
            ),
        ).toBeInTheDocument();
        expect(
            container.querySelector(
                'img[src*="/icons/legal-sources/legislation.svg"]',
            ),
        ).toBeInTheDocument();
        expect(container.querySelector("canvas")).not.toBeInTheDocument();
    });
});
