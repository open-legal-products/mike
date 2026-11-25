import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { PanelDocument } from "./types";
import { DocumentContent } from "./DocumentContent";

const { viewer, loadVersions } = vi.hoisted(() => ({ viewer: vi.fn(), loadVersions: vi.fn() }));
vi.mock("./views/DocxView", () => ({
    DocxView: (props: { displayUrl?: string | null }) => {
        viewer(props);
        return <div>{props.displayUrl ? "Redline canvas" : "DOCX canvas"}</div>;
    },
}));
vi.mock("./views/PdfView", () => ({ PdfView: () => <div>PDF canvas</div> }));
vi.mock("./views/SpreadsheetView", () => ({ SpreadsheetView: () => <div>Sheet canvas</div> }));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getDocument: vi.fn().mockResolvedValue({ can_edit: true, can_delete: true }),
    listDocumentVersions: loadVersions,
}));

const version = (id: string, n: number) => ({
    id, version_number: n, source: "upload", created_at: "2026-11-01", filename: "MSA.docx", file_type: "docx",
});
const panelDocument = (versionId: string, versionNumber: number, extra: Partial<PanelDocument> = {}): PanelDocument => ({
    document_id: "doc", title: "MSA.docx", type: "docx", metadata: [], quotes: [],
    version_id: versionId, version_number: versionNumber, ...extra,
});
const lastViewer = () => viewer.mock.calls.at(-1)![0] as Record<string, unknown>;
const openComparison = async (user: ReturnType<typeof userEvent.setup>, current: number, previous: number) => {
    await user.click(await screen.findByRole("button", { name: `Choose document version, currently V${current}` }));
    await user.click(await screen.findByRole("menuitem", { name: `Compare with V${previous}` }));
};

beforeEach(() => {
    viewer.mockReset();
    loadVersions.mockReset().mockResolvedValue({
        current_version_id: "v3", versions: [version("v1", 1), version("v2", 2), version("v3", 3)],
    });
});

it("shows a read-only redline of the displayed version against the previous one, then returns to the document", async () => {
    const user = userEvent.setup();
    render(<DocumentContent document={panelDocument("v3", 3)} mode={{ kind: "document" }} canEdit onVersionChange={vi.fn()} />);
    expect(await screen.findByText("DOCX canvas")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();

    await openComparison(user, 3, 2);
    expect(await screen.findByText("Redline canvas")).toBeInTheDocument();
    expect(screen.getByText("Changes since V2")).toBeInTheDocument();
    expect(lastViewer()).toMatchObject({
        documentId: "doc",
        displayUrl: "/api/single-documents/doc/versions/compare?base=v2&target=v3",
        canEdit: false,
        cacheBytes: false,
        filename: "MSA (V2 to V3 comparison).docx",
    });
    // A redline is never editable and never autosaves over the stored version.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(lastViewer().onSaveStateChange).toBeUndefined();
    expect(lastViewer().versionId).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(await screen.findByText("DOCX canvas")).toBeInTheDocument();
    expect(screen.queryByText("Changes since V2")).toBeNull();
    expect(lastViewer()).toMatchObject({ documentId: "doc", versionId: "v3", canEdit: true });
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
});

it("leaves the comparison when the displayed version changes", async () => {
    const user = userEvent.setup();
    const view = render(<DocumentContent document={panelDocument("v3", 3)} mode={{ kind: "document" }} onVersionChange={vi.fn()} />);
    await openComparison(user, 3, 2);
    expect(await screen.findByText("Redline canvas")).toBeInTheDocument();

    view.rerender(<DocumentContent document={panelDocument("v2", 2)} mode={{ kind: "document" }} onVersionChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("DOCX canvas")).toBeInTheDocument());
    expect(screen.queryByText(/Changes since/)).toBeNull();
    expect(lastViewer()).toMatchObject({ versionId: "v2" });
});

it("does not offer a comparison for a PDF", async () => {
    loadVersions.mockResolvedValue({
        current_version_id: "p2",
        versions: [{ ...version("p1", 1), filename: "MSA.pdf", file_type: "pdf" }, { ...version("p2", 2), filename: "MSA.pdf", file_type: "pdf" }],
    });
    const user = userEvent.setup();
    render(<DocumentContent document={panelDocument("p2", 2, { title: "MSA.pdf", type: "pdf" })} mode={{ kind: "document" }} onVersionChange={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Choose document version, currently V2" }));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /V1/ })).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: /Compare with/ })).toBeNull();
});
