import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { AssistantSidePanel } from "../assistant/AssistantSidePanel";
import { ProjectDocumentTabs } from "../projects/ProjectDocumentTabs";
import { panelDocumentAtVersion } from "@/app/lib/panelDocumentAtVersion";
import type { DocumentVersion } from "@/app/lib/mikeApi";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocPanel } from "../assistant/DocPanel";
import { ProjectDocumentPanels } from "../projects/ProjectDocumentPanels";
import {
    panelDocumentFromCitation,
    type DocumentCitation,
    type EditAnnotation,
} from "./types";
import type { DocumentContentMode } from "./DocumentContent";

const { viewer, resolveEdit, loadVersions } = vi.hoisted(() => ({
    viewer: vi.fn(),
    resolveEdit: vi.fn(),
    loadVersions: vi.fn(),
}));
vi.mock("./views/DocxView", () => ({
    DocxView: (props: unknown) => {
        viewer(props);
        return <div>DOCX canvas</div>;
    },
}));
vi.mock("./views/PdfView", () => ({
    PdfView: (props: unknown) => {
        viewer(props);
        return <div>PDF canvas</div>;
    },
}));
vi.mock("./views/SpreadsheetView", () => ({
    SpreadsheetView: (props: unknown) => {
        viewer(props);
        return <div>Sheet canvas</div>;
    },
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    resolveDocumentEdit: resolveEdit,
    listDocumentVersions: loadVersions,
}));

const citation: DocumentCitation = {
    type: "citation_data",
    ref: 1,
    doc_id: "doc-0",
    document_id: "doc",
    filename: "Agreement.docx",
    page: 1,
    quote: "First clause",
    quotes: [
        { page: 1, quote: "First clause" },
        { page: 2, quote: "Second clause" },
    ],
};
const edit: EditAnnotation = {
    edit_id: "edit",
    document_id: "doc",
    version_id: "v1",
    change_id: "change",
    inserted_text: "New wording",
    deleted_text: "Old wording",
    status: "pending",
};
const onClose = vi.fn();
const onResolved = vi.fn();
const onStart = vi.fn();
function content(
    surface: "assistant" | "project",
    mode: DocumentContentMode,
    active = true,
) {
    if (surface === "assistant")
        return (
            <DocPanel
                showToolbarToggle
                document={panelDocumentFromCitation(
                    mode.kind === "citation" ? mode.citation : citation,
                )}
                mode={
                    mode.kind === "edit"
                        ? { ...mode, onResolved, onResolveStart: onStart }
                        : mode
                }
                active={active}
                onCloseAnnotation={onClose}
            />
        );
    return (
        <ProjectDocumentPanels
            tabs={[
                {
                    documentId: "doc",
                    filename: "Agreement.docx",
                    versionId: "v1",
                    annotation: mode.kind === "document" ? undefined : mode,
                },
            ]}
            documents={[]}
            activeTabId={active ? "doc" : null}
            onWarningDismiss={vi.fn()}
            onCloseAnnotation={onClose}
            onEditResolved={onResolved}
            onEditResolveStart={onStart}
        />
    );
}
function viewerProps() {
    return viewer.mock.calls.at(-1)![0];
}
beforeEach(() => {
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["assistant", "project"] as const)(
    "%s shared content",
    (surface) => {
        it("offers Edit in both surfaces with their defaults and retains its state per panel", () => {
            const { rerender } = render(content(surface, { kind: "document" }));
            const button = screen.getByRole("button", { name: "Edit" });
            if (surface === "project") {
                expect(viewerProps().toolbarVisible).toBe(true);
                expect(button).toHaveAttribute("aria-pressed", "true");
                fireEvent.click(button);
            }
            expect(viewerProps().toolbarVisible).toBe(false);
            expect(button).toHaveClass("bg-transparent", "shadow-none", "text-muted-foreground");
            expect(button).toHaveAttribute("aria-expanded", "false");
            expect(button).toHaveAttribute("aria-pressed", "false");
            fireEvent.click(button);
            expect(viewerProps().toolbarVisible).toBe(true);
            expect(button).toHaveAttribute("aria-expanded", "true");
            expect(button).toHaveAttribute("aria-pressed", "true");
            expect(button).toHaveClass("text-foreground");
            expect(button).not.toHaveClass("text-muted-foreground");
            expect(viewerProps().defaultMode).toBe("edit");
            rerender(content(surface, { kind: "document" }, false));
            rerender(content(surface, { kind: "citation", citation }));
            expect(viewerProps().toolbarVisible).toBe(true);
            fireEvent.click(button);
            expect(viewerProps().toolbarVisible).toBe(false);
            expect(button).toHaveAttribute("aria-expanded", "false");
            expect(button).toHaveAttribute("aria-pressed", "false");
            expect(button).toHaveClass("text-muted-foreground");
            expect(button).not.toHaveClass("text-foreground");
        });

        it("shows citation quotes, selects and deselects highlights, and reopens after dismissal", () => {
            const mode: DocumentContentMode = { kind: "citation", citation };
            const { rerender } = render(content(surface, mode));
            expect(screen.getByText(/First clause/)).toBeVisible();
            const annotation = screen.getByRole("region", {
                name: "Document annotation",
            });
            expect(annotation).toContainElement(
                screen.getByText(/First clause/),
            );
            expect(annotation.parentElement).not.toContainElement(
                screen.getByText("DOCX canvas"),
            );
            expect(annotation.parentElement).toContainElement(
                screen.getByRole("heading", { name: "Agreement.docx" }),
            );
            expect(
                annotation.compareDocumentPosition(
                    screen.getByText("DOCX canvas"),
                ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
            expect(viewerProps().quotes).toEqual([
                { page: 1, quote: "First clause" },
            ]);
            fireEvent.click(screen.getByRole("button", { name: "2" }));
            expect(viewerProps().quotes).toEqual([
                { page: 2, quote: "Second clause" },
            ]);
            fireEvent.click(screen.getByRole("button", { name: "View" }));
            expect(viewerProps().quotes).toEqual([]);
            fireEvent.click(
                screen.getByRole("button", { name: "Close" }),
            );
            expect(onClose).toHaveBeenCalledOnce();
            rerender(content(surface, { kind: "document" }));
            expect(
                screen.queryByRole("button", { name: "Close" }),
            ).toBeNull();
            expect(viewerProps().quotes).toBeUndefined();
            rerender(content(surface, mode));
            expect(viewerProps().quotes).toEqual([
                { page: 1, quote: "First clause" },
            ]);
        });

        it("preserves quote selection while inactive and resets it for another citation", () => {
            const mode: DocumentContentMode = { kind: "citation", citation };
            const { rerender } = render(content(surface, mode));
            fireEvent.click(screen.getByRole("button", { name: "2" }));
            rerender(content(surface, mode, false));
            expect(viewerProps().quotes).toBeUndefined();
            rerender(content(surface, mode));
            expect(viewerProps().quotes).toEqual([
                { page: 2, quote: "Second clause" },
            ]);
            rerender(
                content(surface, {
                    kind: "citation",
                    citation: { ...citation, ref: 2 },
                }),
            );
            expect(viewerProps().quotes).toEqual([
                { page: 1, quote: "First clause" },
            ]);
        });

        it("does not highlight unverified quotes", () => {
            render(
                content(surface, {
                    kind: "citation",
                    citation: {
                        ...citation,
                        quotes: [
                            {
                                page: 1,
                                quote: "Unmatched",
                                verification: { verified: false },
                            },
                        ],
                    },
                }),
            );
            expect(screen.getByRole("button", { name: "View" })).toBeDisabled();
            expect(viewerProps().quotes).toEqual([]);
        });

        it("keeps Download icon-only at narrow and wide widths on both surfaces", () => {
            let resize: ResizeObserverCallback;
            const disconnect = vi.fn();
            vi.stubGlobal(
                "ResizeObserver",
                class {
                    constructor(callback: ResizeObserverCallback) {
                        resize = callback;
                    }
                    observe() {}
                    disconnect = disconnect;
                },
            );
            const { unmount } = render(content(surface, { kind: "document" }));
            act(() =>
                resize(
                    [{ contentRect: { width: 400 } } as ResizeObserverEntry],
                    {} as ResizeObserver,
                ),
            );
            expect(
                screen.getByRole("button", { name: "Download" }),
            ).toHaveClass("w-6");
            act(() =>
                resize(
                    [{ contentRect: { width: 800 } } as ResizeObserverEntry],
                    {} as ResizeObserver,
                ),
            );
            expect(
                screen.getByRole("button", { name: "Download" }),
            ).toHaveClass("w-6");
            unmount();
            expect(disconnect).toHaveBeenCalledOnce();
        });

        it("shows an edit, refocuses it, and reports accept to the host", async () => {
            resolveEdit.mockResolvedValue({
                status: "accepted",
                version_id: "v1",
                download_url: null,
            });
            render(content(surface, { kind: "edit", edit, changeNumber: 3 }));
            expect(screen.getByText("New wording")).toBeVisible();
            const annotation = screen.getByRole("region", {
                name: "Document annotation",
            });
            expect(annotation.parentElement).toContainElement(
                screen.getByRole("heading", { name: "Agreement.docx" }),
            );
            expect(
                annotation.compareDocumentPosition(
                    screen.getByText("DOCX canvas"),
                ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
            const previousKey = viewerProps().highlightEdit.key;
            fireEvent.click(screen.getByRole("button", { name: "View" }));
            expect(viewerProps().highlightEdit.key).not.toBe(previousKey);
            fireEvent.click(screen.getByRole("button", { name: "Accept" }));
            expect(onStart).toHaveBeenCalledWith({
                editId: "edit",
                documentId: "doc",
                verb: "accept",
            });
            await waitFor(() =>
                expect(onResolved).toHaveBeenCalledWith({
                    editId: "edit",
                    documentId: "doc",
                    status: "accepted",
                    versionId: "v1",
                    downloadUrl: null,
                }),
            );
            expect(resolveEdit).toHaveBeenCalledWith("doc", "edit", "accept");
        });
    },
);

it("opens a case citation in the IDE with the same opinion and quote section", () => {
    const document = {
        document_id: "case:1",
        title: "Example v Example",
        type: "case" as const,
        quotes: [
            { quote: "The holding", target: { subdocument_id: "opinion" } },
        ],
        metadata: [],
        subdocuments: [
            {
                document_id: "opinion",
                title: "Opinion",
                type: "html" as const,
                html: "<p>The holding of this case.</p>",
            },
        ],
    };
    render(
        <ProjectDocumentPanels
            documents={[]}
            activeTabId="case:1"
            onWarningDismiss={vi.fn()}
            tabs={[
                {
                    documentId: "case:1",
                    filename: document.title,
                    sourceDocument: document,
                    annotation: {
                        kind: "citation",
                        citation: {
                            type: "citation_data",
                            kind: "case",
                            ref: 4,
                            cluster_id: 1,
                            document,
                            quotes: [
                                {
                                    quote: "The holding",
                                    opinionId: null,
                                    type: null,
                                    author: null,
                                },
                            ],
                        },
                    },
                },
            ]}
        />,
    );
    expect(screen.getByRole("heading", { name: document.title })).toBeVisible();
    expect(screen.getByLabelText("Citation 4")).toBeVisible();
    expect(screen.getByText(/of this case/)).toBeVisible();
    expect(viewer).not.toHaveBeenCalled();
});

it("maps spreadsheet citation cells into the IDE viewer", () => {
    const sheetCitation = {
        ...citation,
        filename: "Budget.xlsx",
        quotes: [{ page: 1, quote: "1250", sheet: "Summary", cell: "B7" }],
    };
    render(
        <ProjectDocumentPanels
            documents={[]}
            activeTabId="doc"
            onWarningDismiss={vi.fn()}
            tabs={[
                {
                    documentId: "doc",
                    filename: "Budget.xlsx",
                    annotation: { kind: "citation", citation: sheetCitation },
                },
            ]}
        />,
    );
    expect(screen.getByText(/Summary, cell B7/)).toBeVisible();
    expect(viewerProps().highlightCells).toEqual([
        { sheet: "Summary", cell: "B7" },
    ]);
});

it.each(["pdf", "spreadsheet", "case"] as const)(
    "does not offer the DOCX toolbar toggle for %s documents",
    (type) => {
        render(
            <DocPanel
                showToolbarToggle
                document={{
                    document_id: "other",
                    title: "Other document",
                    type,
                    metadata: [],
                    quotes: [],
                }}
                mode={{ kind: "document" }}
            />,
        );
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    },
);

function VersionHarness({ surface }: { surface: "assistant" | "project" }) {
    const [document, setDocument] = useState({
        ...panelDocumentFromCitation(citation),
        version_id: "v1",
        version_number: 1,
    });
    const [mode, setMode] = useState<DocumentContentMode>({
        kind: "citation",
        citation,
    });
    const onVersionChange = (version: DocumentVersion) => {
        setDocument((current) => ({
            ...panelDocumentAtVersion(current, version),
            version_id: version.id,
            version_number: version.version_number!,
        }));
        setMode({ kind: "document" });
    };
    if (surface === "assistant")
        return (
            <AssistantSidePanel
                tabs={[{ id: "doc", document, ...mode }]}
                activeTabId="doc"
                onActivateTab={vi.fn()}
                onCloseTab={vi.fn()}
                onCloseAll={vi.fn()}
                onVersionChange={(_id, version) => onVersionChange(version)}
            />
        );
    const tabs = [
        {
            documentId: "doc",
            filename: document.title,
            versionId: document.version_id,
            sourceDocument: document,
            annotation: mode.kind === "document" ? undefined : mode,
        },
    ];
    return (
        <>
            <ProjectDocumentTabs
                tabs={tabs}
                documents={[]}
                activeTabId="doc"
                onActivate={vi.fn()}
                onClose={vi.fn()}
                onReorder={vi.fn()}
            />
            <ProjectDocumentPanels
                tabs={tabs}
                documents={[]}
                activeTabId="doc"
                onWarningDismiss={vi.fn()}
                onVersionChange={(_id, version) => onVersionChange(version)}
            />
        </>
    );
}

it.each(["assistant", "project"] as const)(
    "switches the %s viewer version inside one tab and clears the old annotation",
    async (surface) => {
        loadVersions.mockResolvedValue({
            current_version_id: "v2",
            versions: [
                {
                    id: "v1",
                    version_number: 1,
                    filename: "Agreement.docx",
                    source: "upload",
                    created_at: "2026-09-26",
                },
                {
                    id: "v2",
                    version_number: 2,
                    filename: "Agreement.docx",
                    source: "upload",
                    created_at: "2026-09-26",
                },
            ],
        });
        const user = userEvent.setup();
        render(<VersionHarness surface={surface} />);
        expect(viewerProps().versionId).toBe("v1");
        expect(screen.getByText(/First clause/)).toBeVisible();
        await user.click(
            await screen.findByRole("button", {
                name: "Choose document version, currently V1",
            }),
        );
        await user.click(
            await screen.findByRole("menuitemradio", { name: /V2/ }),
        );
        expect(viewerProps().versionId).toBe("v2");
        expect(screen.getAllByRole("tab")).toHaveLength(1);
        expect(screen.queryByText(/First clause/)).toBeNull();
        expect(viewerProps().quotes).toBeUndefined();
    },
);
