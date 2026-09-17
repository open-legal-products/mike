import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import type { Document } from "@/app/components/shared/types";
import {
    ProjectDocumentPanels,
    type ProjectDocumentTab,
} from "./ProjectDocumentPanels";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("./ProjectWorkspaceTips", () => ({
    ProjectWorkspaceTips: () => <p>Open a document</p>,
}));

function Viewer({ id, loaded }: { id: string; loaded: boolean }) {
    const [zoom, setZoom] = useState(1);
    return (
        <div data-testid={id} style={{ overflow: "auto" }}>
            <span>{loaded ? "Loaded" : "Loading"}</span>
            <button onClick={() => setZoom(zoom + 0.25)}>Zoom {zoom}</button>
        </div>
    );
}
vi.mock("@/app/components/shared/views/PdfView", () => ({
    PdfView: ({
        doc,
        refetchKey,
    }: {
        doc: { document_id: string; version_id?: string | null };
        refetchKey: string;
    }) => {
        const { result } = useFetchSingleDoc(
            doc.document_id,
            doc.version_id,
            null,
            refetchKey,
        );
        return <Viewer id={doc.document_id} loaded={!!result} />;
    },
}));
vi.mock("@/app/components/shared/views/SpreadsheetView", () => ({
    SpreadsheetView: ({
        documentId,
        versionId,
        refetchKey,
    }: {
        documentId: string;
        versionId?: string | null;
        refetchKey: string;
    }) => {
        const { result } = useFetchSingleDoc(
            documentId,
            versionId,
            null,
            refetchKey,
        );
        return <Viewer id={documentId} loaded={!!result} />;
    },
}));
vi.mock("@/app/components/shared/views/DocxView", () => ({
    DocxView: ({
        documentId,
        versionId,
        refetchKey,
        cacheBytes,
    }: {
        documentId: string;
        versionId?: string | null;
        refetchKey: string;
        cacheBytes: boolean;
    }) => {
        const { bytes } = useFetchDocxBytes(
            documentId,
            versionId,
            refetchKey,
            null,
            cacheBytes,
        );
        return <Viewer id={documentId} loaded={!!bytes} />;
    },
}));

const tabs: ProjectDocumentTab[] = [
    { documentId: "pdf", filename: "Brief.pdf" },
    { documentId: "sheet", filename: "Budget.xlsx" },
    { documentId: "docx", filename: "Draft.docx" },
];
const documents = tabs.map((tab) => ({
    id: tab.documentId,
    current_version_id: "v1",
    updated_at: "t1",
    status: "ready",
})) as Document[];
const dismiss = vi.fn();
beforeEach(() => {
    vi.mocked(authenticatedFetch)
        .mockReset()
        .mockImplementation(
            async (url) =>
                new Response(new Uint8Array([1, 2, 3]), {
                    headers: {
                        "Content-Type": String(url).includes("sheet")
                            ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                            : "application/pdf",
                    },
                }),
        );
});
afterEach(() => vi.restoreAllMocks());

function panels(openTabs = tabs, activeTabId = "pdf", docs = documents) {
    return (
        <ProjectDocumentPanels
            tabs={openTabs}
            documents={docs}
            activeTabId={activeTabId}
            onWarningDismiss={dismiss}
        />
    );
}

it("retains loaded files, zoom, and scroll across tab switches and releases viewers on close", async () => {
    const { rerender } = render(panels());
    await waitFor(() => expect(screen.getAllByText("Loaded")).toHaveLength(3));
    const viewer = screen.getByTestId("pdf");
    viewer.scrollTop = 340;
    fireEvent.click(screen.getByRole("button", { name: "Zoom 1" }));
    rerender(panels(tabs, "sheet"));
    expect(viewer.closest('[role="tabpanel"]')).toHaveAttribute(
        "aria-hidden",
        "true",
    );
    expect(viewer.closest('[role="tabpanel"]')).toHaveAttribute("inert");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    rerender(panels(tabs, "pdf"));
    expect(screen.getByTestId("pdf")).toBe(viewer);
    expect(viewer.scrollTop).toBe(340);
    expect(screen.getByRole("button", { name: "Zoom 1.25" })).toBeVisible();
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    rerender(
        panels(
            tabs.filter((tab) => tab.documentId !== "pdf"),
            "sheet",
        ),
    );
    expect(viewer.isConnected).toBe(false);
    rerender(panels());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(4));
    expect(screen.getByTestId("pdf")).not.toBe(viewer);
    // DOCX workspace bytes also expire with the tab, rather than entering the global cache.
    const docxViewer = screen.getByTestId("docx");
    rerender(panels(tabs.filter((tab) => tab.documentId !== "docx")));
    rerender(panels());
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(5));
    expect(screen.getByTestId("docx")).not.toBe(docxViewer);
});

it("refreshes changed current versions and overwritten bytes, while keeping historical versions pinned", async () => {
    const pinned = tabs.map((tab) =>
        tab.documentId === "pdf" ? { ...tab, versionId: "historical" } : tab,
    );
    const { rerender } = render(panels(pinned));
    await waitFor(() => expect(screen.getAllByText("Loaded")).toHaveLength(3));
    const changed = documents.map((doc) => ({
        ...doc,
        current_version_id: "v2",
        updated_at: "t2",
    }));
    rerender(panels(pinned, "sheet", changed));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(5));
    const urls = vi
        .mocked(authenticatedFetch)
        .mock.calls.map(([url]) => String(url));
    expect(urls.filter((url) => url.includes("pdf"))).toHaveLength(1);
    expect(urls.find((url) => url.includes("pdf"))).toContain(
        "version_id=historical",
    );
    expect(urls.filter((url) => url.includes("sheet"))[1]).toContain(
        "version_id=v2",
    );
    rerender(
        panels(
            pinned,
            "docx",
            changed.map((doc) =>
                doc.id === "docx" ? { ...doc, updated_at: "t3" } : doc,
            ),
        ),
    );
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(6));
    rerender(
        panels(
            pinned.map((tab) =>
                tab.documentId === "pdf" ? { ...tab, refetchKey: 1 } : tab,
            ),
            "pdf",
            changed.map((doc) =>
                doc.id === "docx" ? { ...doc, updated_at: "t3" } : doc,
            ),
        ),
    );
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(7));
});

it("renders the initial view without requesting a file", () => {
    render(panels([], ""));
    expect(screen.getByText("Open a document")).toBeVisible();
    expect(authenticatedFetch).not.toHaveBeenCalled();
});

it("detects content changes to the same current version, including a pinned current version, without reloading for renames", async () => {
    const withHashes = documents.map((doc) => ({
        ...doc,
        content_sha256: "a".repeat(64),
    }));
    const pinnedCurrent = tabs.map((tab) =>
        tab.documentId === "pdf" ? { ...tab, versionId: "v1" } : tab,
    );
    const { rerender } = render(panels(pinnedCurrent, "pdf", withHashes));
    await waitFor(() => expect(screen.getAllByText("Loaded")).toHaveLength(3));
    rerender(
        panels(
            pinnedCurrent,
            "pdf",
            withHashes.map((doc) => ({
                ...doc,
                filename: "Renamed.pdf",
                updated_at: "renamed",
            })),
        ),
    );
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    rerender(
        panels(
            pinnedCurrent,
            "pdf",
            withHashes.map((doc) => ({
                ...doc,
                content_sha256: "b".repeat(64),
            })),
        ),
    );
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(6));
});
