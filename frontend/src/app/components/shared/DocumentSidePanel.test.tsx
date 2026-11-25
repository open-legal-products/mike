import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";
import type { Document } from "@/app/components/shared/types";
import { getDocumentComparison, type DocumentVersion } from "@/app/lib/mikeApi";
import { DocumentSidePanel } from "./DocumentSidePanel";

vi.mock("@/app/lib/mikeApi", async (original) => ({
    ...(await original<typeof import("@/app/lib/mikeApi")>()),
    getDocumentComparison: vi.fn(),
}));

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

function renderPanel(
    onClose = vi.fn(),
    options: { readOnly?: boolean; versions?: DocumentVersion[] } = {},
) {
    render(
        <DocumentSidePanel
            doc={doc}
            readOnly={options.readOnly ?? true}
            versions={options.versions ?? []}
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

const version = (n: number, createdAt = "2026-09-01"): DocumentVersion => ({
    id: `v${n}`,
    version_number: n,
    source: "upload",
    created_at: createdAt,
    filename: `agreement-v${n}.docx`,
});

it("titles the document view and lists the latest version first", () => {
    renderPanel(vi.fn(), {
        readOnly: false,
        // Out of order on purpose: the list must not rely on the API's order.
        versions: [
            version(1, "2026-09-01T00:00:00Z"),
            version(3, "2026-09-02T00:00:00Z"),
            version(2, "2026-09-03T00:00:00Z"),
        ],
    });

    expect(
        screen.getByRole("heading", { name: "agreement-v3.docx" }),
    ).toBeInTheDocument();
    expect(
        screen
            .getAllByRole("button", { name: /^Download Version/ })
            .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
        "Download Version 3",
        "Download Version 2",
        "Download Version 1",
    ]);
});

it("opens and closes a comparison from version history without a chat", async () => {
    vi.mocked(getDocumentComparison).mockResolvedValue(new ArrayBuffer(4));
    renderPanel(vi.fn(), { readOnly: false, versions: [version(1), version(2)] });

    fireEvent.click(screen.getByRole("button", { name: "Compare V2 with V1" }));
    expect(await screen.findByRole("heading", {
        name: "agreement-v2.docx",
    })).toBeVisible();
    expect(getDocumentComparison).toHaveBeenCalledWith("doc-1", "v1", "v2", expect.any(AbortSignal));
    expect(screen.getByRole("button", { name: "Download comparison" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.getByRole("heading", { name: "agreement-v2.docx" })).toBeVisible();
});

it("explains when either version exceeds the comparison size limit", () => {
    renderPanel(vi.fn(), {
        readOnly: false,
        versions: [{ ...version(1), size_bytes: 21 * 1024 * 1024 }, version(2)],
    });
    expect(screen.getByRole("button", { name: "Compare V2 with V1" })).toBeDisabled();
    expect(screen.getByText(/20 MiB/)).toBeVisible();
});

it("compares the displayed version with a nonconsecutive baseline from the menu", async () => {
    const user = userEvent.setup();
    vi.mocked(getDocumentComparison).mockResolvedValue(new ArrayBuffer(4));
    renderPanel(vi.fn(), { readOnly: false, versions: [version(2), version(3), version(1)] });

    await user.click(screen.getByRole("button", { name: "Compare versions" }));
    expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual([
        "Compare with V2", "Compare with V1",
    ]);
    await user.click(screen.getByRole("menuitem", { name: "Compare with V1" }));
    expect(getDocumentComparison).toHaveBeenCalledWith("doc-1", "v1", "v3", expect.any(AbortSignal));
    expect(await screen.findByRole("group", { name: "Document comparison" })).toHaveTextContent("V1toV3");
});
