import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewportUI, clearToasts } from "@/shared/ui/ToastUI";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import type { Document } from "./types";
import { DocumentSidePanel } from "./DocumentSidePanel";

// The viewers fetch and render real document bytes; none of that is part of
// what this suite asserts.
vi.mock("./views/PdfView", () => ({ PdfView: () => <div>pdf</div> }));
vi.mock("./views/DocxView", () => ({ DocxView: () => <div>docx</div> }));
vi.mock("./views/SpreadsheetView", () => ({
    SpreadsheetView: () => <div>sheet</div>,
}));

function version(overrides: Partial<DocumentVersion> = {}): DocumentVersion {
    return {
        id: "version-1",
        version_number: 1,
        filename: "Brief.docx",
        file_type: "docx",
        size_bytes: 10,
        page_count: 1,
        created_at: "2026-09-01T00:00:00.000Z",
        deleted_at: null,
        ...overrides,
    } as DocumentVersion;
}

function doc(): Document {
    return {
        id: "doc-1",
        project_id: null,
        filename: "Brief.docx",
        file_type: "docx",
        storage_path: null,
        pdf_storage_path: null,
        size_bytes: 10,
        page_count: 1,
        structure_tree: null,
        status: "ready",
        created_at: "2026-09-01T00:00:00.000Z",
        active_version_number: 1,
    } as Document;
}

function renderPanel(overrides: Record<string, unknown> = {}) {
    const props = {
        doc: doc(),
        versions: [version()],
        versionsLoading: false,
        onClose: vi.fn(),
        onLoadVersions: vi.fn(),
        onSelectVersion: vi.fn(),
        onDownloadDocument: vi.fn(),
        onDownloadVersion: vi.fn(),
        onRenameVersion: vi.fn(),
        onDeleteVersion: vi.fn(),
        onUploadNewVersion: vi.fn(),
        onReplaceVersion: vi.fn(),
        onDelete: vi.fn(),
        ...overrides,
    };
    render(
        <>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            <DocumentSidePanel {...(props as any)} />
            <ToastViewportUI />
        </>,
    );
    return props;
}

describe("DocumentSidePanel failures", () => {
    beforeEach(() => clearToasts());
    afterEach(() => clearToasts());

    it("reports a failed document delete instead of quietly reopening the panel", async () => {
        const user = userEvent.setup();
        const onDelete = vi.fn().mockRejectedValue(
            Object.assign(new Error("API error: 500"), { status: 500 }),
        );
        renderPanel({ onDelete });

        await user.click(screen.getByRole("button", { name: /^Delete$/ }));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't delete this document");
        expect(alert).not.toHaveTextContent("API error: 500");
    });

    it("retries a failed document delete from the notice", async () => {
        const user = userEvent.setup();
        const onDelete = vi
            .fn()
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(undefined);
        renderPanel({ onDelete });

        await user.click(screen.getByRole("button", { name: /^Delete$/ }));
        await user.click(await screen.findByRole("button", { name: "Retry" }));

        expect(onDelete).toHaveBeenCalledTimes(2);
    });

    it("reports a failed version delete", async () => {
        const user = userEvent.setup();
        const onDeleteVersion = vi
            .fn()
            .mockRejectedValue(new TypeError("Failed to fetch"));
        renderPanel({
            versions: [
                version(),
                version({ id: "version-2", version_number: 2 }),
            ],
            onDeleteVersion,
        });

        await user.click(
            screen.getByRole("button", { name: "Delete Version 2" }),
        );

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Couldn't delete this version",
        );
    });

    it("explains a refused rename without leaking the raw failure", async () => {
        const user = userEvent.setup();
        const onRenameVersion = vi.fn().mockRejectedValue(
            Object.assign(new Error("API error: 500"), { status: 500 }),
        );
        renderPanel({ onRenameVersion });

        await user.click(screen.getByTitle("Edit name"));
        const input = screen.getByDisplayValue("Brief.docx");
        await user.clear(input);
        await user.type(input, "Final brief.docx");
        await user.click(screen.getByTitle("Save name"));

        expect(
            await screen.findByText("Something went wrong on our side. Try again."),
        ).toBeVisible();
        expect(screen.queryByText(/API error: 500/)).not.toBeInTheDocument();
    });

    it("warns about an extension change in a notice rather than a blocking popup", async () => {
        const user = userEvent.setup();
        const onRenameVersion = vi.fn();
        renderPanel({ onRenameVersion });

        await user.click(screen.getByTitle("Edit name"));
        const input = screen.getByDisplayValue("Brief.docx");
        await user.clear(input);
        await user.type(input, "Brief.pdf");
        await user.click(screen.getByTitle("Save name"));

        const alert = await screen.findByRole("alert");
        expect(alert).toHaveTextContent("Couldn't rename this version");
        expect(alert).toHaveTextContent("Keep .docx at the end of the name.");
        expect(onRenameVersion).not.toHaveBeenCalled();
    });
});
