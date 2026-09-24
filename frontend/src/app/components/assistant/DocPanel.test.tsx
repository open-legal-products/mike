import { useEffect } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DocPanel, DocumentTitleRow } from "./DocPanel";
import type { DocxSaveState } from "../shared/views/DocxRenderer.types";

vi.mock("../shared/views/DocxView", () => ({
    DocxView: ({ defaultMode, filename, documentId, onSaveStateChange }: {
        defaultMode: string; filename: string; documentId: string;
        onSaveStateChange?: (id: string, state: DocxSaveState | null) => void;
    }) => {
        useEffect(() => {
            onSaveStateChange?.(documentId, { ready: true, dirty: true, status: "pending", error: null });
            return () => onSaveStateChange?.(documentId, null);
        }, [documentId, onSaveStateChange]);
        return <div data-testid="docx-editor" data-mode={defaultMode}>{filename}</div>;
    },
}));

it("opens assistant DOCX documents in edit mode", () => {
    render(<DocPanel mode={{ kind: "document" }} document={{
        document_id: "docx-1", title: "agreement.docx", type: "docx", metadata: [], quotes: [],
    }} />);
    expect(screen.getByTestId("docx-editor")).toHaveAttribute("data-mode", "edit");
    expect(screen.getByRole("heading", { name: "agreement.docx" })).toBeVisible();
    const download = screen.getByRole("button", { name: /download/i });
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    expect(screen.getByRole("status").parentElement).toBe(download.parentElement);
    expect(screen.queryByRole("button", { name: /sav/i })).toBeNull();
});

describe("DocumentTitleRow", () => {
    it("shows autosave progress and errors as plain text beside Download", () => {
        const document = { document_id: "doc", title: "Draft.docx", type: "docx" as const, metadata: [], quotes: [] };
        const state: DocxSaveState = { ready: true, dirty: true, status: "pending", error: null };
        const view = (saveState: DocxSaveState) => <DocumentTitleRow document={document} isReloading={false} compactActions saveState={saveState} />;
        const { rerender } = render(view(state));
        expect(screen.getByRole("status")).toHaveTextContent("Saving…");
        expect(screen.queryByRole("button", { name: /sav/i })).toBeNull();
        rerender(view({ ...state, status: "saving" }));
        expect(screen.getByRole("status")).toHaveTextContent("Saving…");
        rerender(view({ ...state, status: "saved", dirty: false }));
        expect(screen.getByRole("status")).toHaveTextContent("Saved");
        rerender(view(state));
        expect(screen.getByRole("status")).toHaveTextContent("Saving…");
        rerender(view({ ...state, status: "error", error: "Changes could not be saved. Retry or download a copy." }));
        expect(screen.getByRole("alert")).toHaveTextContent("Changes could not be saved");
        expect(screen.getByRole("status")).toHaveTextContent("Not saved");
        expect(screen.queryByRole("button", { name: /sav/i })).toBeNull();
        expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
        rerender(view({ ...state, ready: false }));
        expect(screen.queryByRole("status")).toBeNull();
    });
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
