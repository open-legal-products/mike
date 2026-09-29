import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import { DocumentSidePanel } from "./DocumentSidePanel";

// Stand in for a viewer whose context menu portals to document.body.
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: () =>
        createPortal(<button type="button">Viewer menu item</button>, document.body),
}));

const doc: Document = {
    id: "doc-1",
    project_id: "project-1",
    filename: "agreement.docx",
    file_type: "docx",
    storage_path: "documents/agreement.docx",
    pdf_storage_path: null,
    size_bytes: 1024,
    page_count: null,
    structure_tree: null,
    status: "ready",
    created_at: "2026-09-27T00:00:00Z",
};

function renderPanel(onClose = vi.fn()) {
    render(
        <DocumentSidePanel
            doc={doc}
            readOnly
            versions={[]}
            versionsLoading={false}
            onClose={onClose}
            onLoadVersions={vi.fn()}
            onSelectVersion={vi.fn()}
            onDownloadDocument={vi.fn()}
            onDownloadVersion={vi.fn()}
            onRenameVersion={vi.fn()}
            onDeleteVersion={vi.fn()}
            onUploadNewVersion={vi.fn()}
            onReplaceVersion={vi.fn()}
            onDelete={vi.fn()}
        />,
    );
    return onClose;
}

it("stays open for portaled menus opened from the viewer, but closes on a real outside press", async () => {
    const onClose = renderPanel();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "Viewer menu item" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
});
