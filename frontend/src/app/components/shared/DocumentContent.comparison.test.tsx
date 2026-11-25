import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { downloadBlob, downloadDocumentFile } from "@/app/lib/downloadDocument";
import type { PanelDocument } from "./types";
import { DocumentContent } from "./DocumentContent";

vi.mock("@/app/lib/authEvents", async (original) => ({ ...(await original()), authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/downloadDocument", () => ({ downloadBlob: vi.fn(), downloadDocumentFile: vi.fn() }));

const { viewer, loadVersions } = vi.hoisted(() => ({ viewer: vi.fn(), loadVersions: vi.fn() }));
vi.mock("./views/DocxView", () => ({
    DocxView: (props: { readOnlyFile?: unknown }) => {
        viewer(props);
        return <div>{props.readOnlyFile ? "Redline canvas" : "DOCX canvas"}</div>;
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
    vi.clearAllMocks();
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([7, 8, 9])));
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
    expect(screen.getByText("V2 to V3")).toBeInTheDocument();
    expect(lastViewer()).toMatchObject({
        documentId: "doc",
        readOnlyFile: { bytes: expect.anything() },
        canEdit: false,
        filename: "MSA (V2 to V3 comparison).docx",
    });
    // A redline is never editable and never autosaves over the stored version.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(lastViewer().onSaveStateChange).toBeUndefined();
    expect(lastViewer().versionId).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(await screen.findByText("DOCX canvas")).toBeInTheDocument();
    expect(screen.queryByText("V2 to V3")).toBeNull();
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
    expect(screen.queryByText("V2 to V3")).toBeNull();
    expect(lastViewer()).toMatchObject({ versionId: "v2" });
    view.rerender(<DocumentContent document={panelDocument("v3", 3)} mode={{ kind: "document" }} onVersionChange={vi.fn()} />);
    expect(screen.getByText("DOCX canvas")).toBeVisible();
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
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

it("downloads only the fetched redline, including from a tab menu opened during loading", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const register = vi.fn();
    const user = userEvent.setup();
    render(<DocumentContent document={panelDocument("v3", 3)} mode={{ kind: "document" }}
        onVersionChange={vi.fn()} onDownloadReady={register} />);
    await openComparison(user, 3, 1);
    const button = screen.getByRole("button", { name: "Download comparison" });
    expect(button).toBeDisabled();
    const tabDownload = register.mock.lastCall![0]();
    expect(downloadBlob).not.toHaveBeenCalled();

    await act(async () => {
        finish(new Response(new Uint8Array([7, 8, 9])));
        await tabDownload;
    });
    await user.click(button);
    expect(authenticatedFetch).toHaveBeenCalledOnce();
    expect(authenticatedFetch).toHaveBeenCalledWith("/api/single-documents/doc/versions/compare?base=v1&target=v3",
        expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(downloadDocumentFile).not.toHaveBeenCalled();
    expect(downloadBlob).toHaveBeenCalledTimes(2);
    for (const [blob, name] of vi.mocked(downloadBlob).mock.calls) {
        expect(name).toBe("MSA (V1 to V3 comparison).docx");
        expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 8, 9]);
    }
});

it("suspends the original edit actions until the user closes the comparison", async () => {
    const edit = { edit_id: "edit", document_id: "doc", version_id: "v3", change_id: "1",
        inserted_text: "sixty", deleted_text: "thirty", status: "pending" as const };
    const user = userEvent.setup();
    render(<DocumentContent document={panelDocument("v3", 3)} mode={{ kind: "edit", edit }}
        onVersionChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled();
    await openComparison(user, 3, 2);
    expect(screen.queryByRole("button", { name: /^(Accept|Reject|View)$/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close comparison" }));
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
});

it.each([413, 429])("explains HTTP %s and offers a retry only for transient failures", async status => {
    vi.mocked(authenticatedFetch).mockResolvedValueOnce(new Response(JSON.stringify({ detail: status === 429 ? "Another comparison is running. Please try again shortly." : "Too large" }), { status }));
    const user = userEvent.setup();
    render(<DocumentContent document={panelDocument("v3", 3)} mode={{ kind: "document" }} onVersionChange={vi.fn()} />);
    await openComparison(user, 3, 2);
    expect(await screen.findByRole("alert")).toHaveTextContent(status === 413 ? /20 MiB/ : /Another comparison/);
    expect(screen.getByRole("button", { name: "Download comparison" })).toBeDisabled();
    const retry = screen.queryByRole("button", { name: "Retry comparison" });
    if (status === 413) expect(retry).toBeNull();
    else {
        await user.click(retry!);
        expect(await screen.findByText("Redline canvas")).toBeVisible();
    }
});
