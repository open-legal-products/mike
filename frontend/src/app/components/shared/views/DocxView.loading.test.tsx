import { StrictMode, useEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import type { DocxRendererProps } from "./DocxRenderer.types";
import { DocxView } from "./DocxView";
import { createHash, webcrypto } from "node:crypto";

const exportDocx = vi.hoisted(() => vi.fn());
const activateRevision = vi.hoisted(() => vi.fn());
const clearRevisionHighlight = vi.hoisted(() => vi.fn());
const selectText = vi.hoisted(() => vi.fn());
const clearTextSelection = vi.hoisted(() => vi.fn());
const replaceVersion = vi.hoisted(() => vi.fn());

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    getDocumentFileUrl: (id: string) => "/api/document/" + id,
    replaceDocumentVersionFile: replaceVersion,
    listDocumentVersions: vi.fn().mockResolvedValue({ current_version_id: "v1", versions: [] }),
    MikeApiError: class extends Error {},
}));
vi.mock("./EigenpalDocxRenderer", () => ({
    default: (props: DocxRendererProps) => <MockRenderer {...props} />,
}));

function MockRenderer({ bytes, mode, toolbarVisible = true, onChange, onReady, onError, onSave }: DocxRendererProps) {
    const scroll = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const revision = new Uint8Array(bytes)[0];
    useEffect(() => {
        if (revision === 99) onError();
        else if (scroll.current && content.current) onReady({ scroll: scroll.current, content: content.current, exportDocx, selectText, clearTextSelection, activateRevision, clearRevisionHighlight });
    }, [bytes, onReady, onError, revision]);
    return (
        <div ref={scroll} data-testid="renderer-scroll" data-mode={mode}>
            {mode === "edit" && <div role="toolbar" aria-label="Document formatting" hidden={!toolbarVisible}><button onClick={onChange}>Change document</button></div>}
            <button onClick={() => void onSave?.()}>Save document</button>
            <div ref={content}>
                <p>EigenPal preview</p><p>Document revision {revision}</p>
                <p>Payment in thirty days.</p><p>Confidential information.</p>
                <span data-revision-kind="insert" data-revision-id="7">Repeated edit</span>
                <span data-revision-kind="insert" data-revision-id="8">Repeated edit</span>
            </div>
        </div>
    );
}

const originalScrollTo = HTMLElement.prototype.scrollTo;
beforeEach(() => {
    // jsdom ArrayBuffers belong to a different realm than Node's WebCrypto.
    vi.stubGlobal("crypto", { subtle: { digest: (algorithm: string, bytes: ArrayBuffer) =>
        webcrypto.subtle.digest(algorithm, Buffer.from(new Uint8Array(bytes))) } });
    replaceVersion.mockReset().mockResolvedValue({ id: "v1" });
    exportDocx.mockReset().mockResolvedValue(new Uint8Array([42]).buffer);
    activateRevision.mockReset().mockReturnValue(false);
    clearRevisionHighlight.mockReset();
    selectText.mockReset().mockReturnValue(true);
    clearTextSelection.mockReset();
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([1])));
    HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
        this.scrollTop = typeof options === "number" ? 0 : options?.top ?? 0;
    });
});
afterEach(async () => {
    cleanup();
    // Finish autosave initialization before restoring the WebCrypto realm.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    HTMLElement.prototype.scrollTo = originalScrollTo;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

it("toggles editing controls without replacing the editor or refetching bytes", async () => {
    const view = (toolbarVisible: boolean) => <DocxView documentId="toolbar-toggle" cacheBytes={false} defaultMode="edit" toolbarVisible={toolbarVisible} />;
    const { rerender } = render(view(true));
    const editor = await screen.findByTestId("renderer-scroll");
    const toolbar = screen.getByRole("toolbar");
    editor.scrollTop = 420;
    const calls = vi.mocked(authenticatedFetch).mock.calls.length;
    rerender(view(false));
    expect(toolbar).not.toBeVisible();
    expect(screen.getByTestId("renderer-scroll")).toBe(editor);
    expect(editor.scrollTop).toBe(420);
    expect(editor).toHaveAttribute("data-mode", "edit");
    rerender(view(true));
    expect(toolbar).toBeVisible();
    expect(screen.getByTestId("renderer-scroll")).toBe(editor);
    expect(authenticatedFetch).toHaveBeenCalledTimes(calls);
});

it("keeps the document visible during refresh, hides it on failure, and recovers", async () => {
    let fileResponse = () => Promise.resolve(new Response(new Uint8Array([1])));
    vi.mocked(authenticatedFetch).mockImplementation(() => fileResponse());
    const view = (refetchKey: number) => (
        <StrictMode><DocxView documentId="doc" cacheBytes={false} refetchKey={refetchKey} /></StrictMode>
    );
    const { rerender } = render(view(0));
    const original = await screen.findByText("Document revision 1");
    expect(original).toBeVisible();
    let finish!: (response: Response) => void;
    fileResponse = () => new Promise((resolve) => { finish = resolve; });
    rerender(view(1));
    expect(original).toBeVisible();
    await act(async () => finish(new Response(null, { status: 500 })));
    expect(await screen.findByText("This document could not be loaded. Please try again.")).toBeVisible();
    expect(original).not.toBeVisible();
    fileResponse = () => Promise.resolve(new Response(new Uint8Array([2])));
    rerender(view(2));
    expect(await screen.findByText("Document revision 2")).toBeVisible();
    expect(screen.queryByText("Document revision 1")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
});

it("opens EigenPal without an engine selector and restores the document scroll position", async () => {
    const onScrollChange = vi.fn();
    render(<DocxView documentId="scroll" cacheBytes={false} initialScrollTop={240} onScrollChange={onScrollChange} />);
    await screen.findByText("EigenPal preview");
    expect(screen.queryByRole("group", { name: "DOCX rendering engine" })).toBeNull();
    const scroll = screen.getByTestId("renderer-scroll");
    await waitFor(() => expect(scroll.scrollTop).toBe(240));
    scroll.scrollTop = 320;
    fireEvent.scroll(scroll);
    await waitFor(() => expect(onScrollChange).toHaveBeenCalledWith(320));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});

it("activates the native revision without painting word highlights", async () => {
    activateRevision.mockReturnValue(true);
    const { container } = render(<DocxView documentId="quotes" cacheBytes={false}
        quotes={[{ quote: "Payment in thirty days." }, { quote: "Confidential information." }]}
        highlightEdit={{ key: "edit-8", ins_w_id: "8", inserted_text: "Repeated edit" }} />);
    await screen.findByText("EigenPal preview");
    expect(container.querySelectorAll(".docx-text-highlight")).toHaveLength(0);
    expect(activateRevision).toHaveBeenCalledWith({ ins: "8", del: undefined });
    expect(container.querySelector(".docx-edit-flash")).toBeNull();
    expect(selectText).not.toHaveBeenCalled();
});

it("selects one native citation range and leaves selection alone during repaints and edits", async () => {
    selectText.mockImplementation((text: string) => text === "Payment in thirty days.");
    const quotes = [{ quote: "Missing segment…Payment in thirty days." }, { quote: "Confidential information." }];
    const view = (quoteFocusKey: number) => <DocxView documentId="native-selection" cacheBytes={false}
        defaultMode="edit" quotes={quotes} quoteFocusKey={quoteFocusKey} />;
    const { container, rerender } = render(view(0));
    await screen.findByText("EigenPal preview");
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading document" })).toBeNull());
    expect(selectText).toHaveBeenCalledWith("Missing segment");
    expect(selectText).toHaveBeenLastCalledWith("Payment in thirty days.");
    expect(selectText).not.toHaveBeenCalledWith("Confidential information.");
    expect(container.querySelector(".docx-text-highlight")).toBeNull();
    selectText.mockClear();
    // A newly painted page and a local edit must not reselect an earlier quote.
    const page = document.createElement("div");
    page.className = "docx-page";
    screen.getByText("EigenPal preview").parentElement!.appendChild(page);
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(selectText).not.toHaveBeenCalled();
    rerender(view(1));
    await waitFor(() => expect(selectText).toHaveBeenLastCalledWith("Payment in thirty days."));
    expect(clearTextSelection).not.toHaveBeenCalled();
    rerender(<DocxView documentId="native-selection" cacheBytes={false} defaultMode="edit" quotes={[]} />);
    await waitFor(() => expect(clearTextSelection).toHaveBeenCalledOnce());
    expect(screen.getByText("EigenPal preview")).toBeVisible();
});

it("does not show old bytes while switching documents", async () => {
    const { rerender } = render(<DocxView documentId="old" cacheBytes={false} />);
    await screen.findByText("Document revision 1");
    let finish!: (response: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    rerender(<DocxView documentId="new" cacheBytes={false} />);
    expect(screen.queryByText("Document revision 1")).toBeNull();
    await act(async () => finish(new Response(new Uint8Array([2]))));
    expect(await screen.findByText("Document revision 2")).toBeVisible();
});

it.each(["edit", "view"] as const)("passes the initial %s mode to the native toolbar without a Mike mode toggle", async (mode) => {
    const { rerender } = render(<DocxView documentId="modes" cacheBytes={false} defaultMode={mode} />);
    await screen.findByText("EigenPal preview");
    const surface = screen.getByTestId("renderer-scroll");
    expect(surface).toHaveAttribute("data-mode", mode);
    expect(screen.queryByRole("group", { name: "DOCX mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Download DOCX" })).toBeNull();
    // The native toolbar owns mode changes; parent updates must not reset it.
    rerender(<DocxView documentId="modes" cacheBytes={false} defaultMode={mode === "edit" ? "view" : "edit"} />);
    expect(screen.getByTestId("renderer-scroll")).toBe(surface);
    expect(surface).toHaveAttribute("data-mode", mode);
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});

it("keeps edits after a failed export and downloads the edited bytes on retry", async () => {
    const onSaveStateChange = vi.fn();
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:edited-document");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    exportDocx.mockRejectedValueOnce(new Error("internal serializer details"));
    let download: (() => Promise<void>) | null = null;
    render(<DocxView documentId="export" filename="Agreement.docx" cacheBytes={false} defaultMode="edit"
        onSaveStateChange={onSaveStateChange}
        onDownloadReady={(handler) => { download = handler; }} />);
    await screen.findByText("EigenPal preview");
    await waitFor(() => expect(download).toEqual(expect.any(Function)));
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    await act(async () => download?.());
    expect(await screen.findByText(/Your edits are still open/)).toBeVisible();
    const unsaved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
    expect(screen.queryByText(/internal serializer/)).toBeNull();
    await act(async () => download?.());
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click.mock.instances[0]).toHaveAttribute("download", "Agreement.docx");
    expect(exportDocx).toHaveBeenCalledTimes(2);
    const downloaded = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(downloaded);
    expect(downloaded.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(onSaveStateChange).toHaveBeenLastCalledWith("export", expect.objectContaining({ status: "saved", dirty: false })));
    expect(replaceVersion).toHaveBeenCalledOnce();
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    // Cleanup's revoke timeout can run after the test restores its mocks.
    revokeUrl.mockRestore();
});

it("leaves native revision painting alone during page repaints and clears it on dismissal", async () => {
    activateRevision.mockReturnValue(true);
    const { rerender } = render(<DocxView documentId="paint-settle" cacheBytes={false}
        highlightEdit={{ key: "edit-8", ins_w_id: "8" }} />);
    await screen.findByText("EigenPal preview");
    await waitFor(() => expect(screen.queryByRole("status", { name: "Loading document" })).toBeNull());
    // Finish the initial ready-state effects before observing a later repaint.
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    activateRevision.mockClear();
    clearRevisionHighlight.mockClear();
    const page = document.createElement("div");
    page.className = "docx-page";
    screen.getByText("EigenPal preview").parentElement!.appendChild(page);
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    expect(activateRevision).not.toHaveBeenCalled();
    rerender(<DocxView documentId="paint-settle" cacheBytes={false} />);
    await waitFor(() => expect(clearRevisionHighlight).toHaveBeenCalledOnce());
});

it("reports rendering failure and recovers with new bytes", async () => {
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([99])));
    const { rerender } = render(<DocxView documentId="bad" cacheBytes={false} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This document could not be displayed.");
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([2])));
    rerender(<DocxView documentId="bad" cacheBytes={false} refetchKey={1} />);
    expect(await screen.findByText("Document revision 2")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
});

it("keeps the live editor through metadata refreshes after local editing begins", async () => {
    const view = (refetchKey: number) => <DocxView documentId="live-edit" versionId="v1" cacheBytes={false} defaultMode="edit" refetchKey={refetchKey} />;
    const { rerender } = render(view(0));
    await screen.findByText("Document revision 1");
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    const editor = screen.getByTestId("renderer-scroll");
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([2])));
    rerender(view(1));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("renderer-scroll")).toBe(editor);
    expect(screen.getByText("Document revision 1")).toBeVisible();
});


it("reveals unpainted edits by revision ID before attempting a text fallback", async () => {
    activateRevision.mockReturnValue(true);
    const edit = { key: "later-edit", ins_w_id: "80", del_w_id: "70", inserted_text: "Repeated edit" };
    const { rerender } = render(<DocxView documentId="later-revision" cacheBytes={false} highlightEdit={edit} />);
    await screen.findByText("EigenPal preview");
    await waitFor(() => expect(activateRevision).toHaveBeenCalledWith({ ins: "80", del: "70" }));
    expect(clearRevisionHighlight).not.toHaveBeenCalled();
    expect(selectText).not.toHaveBeenCalled();
    // Legacy documents can still fall back to text when no ID is resolvable.
    activateRevision.mockReturnValue(false);

    rerender(<DocxView documentId="later-revision" cacheBytes={false} highlightEdit={{ ...edit, key: "retry" }} />);
    await waitFor(() => expect(selectText).toHaveBeenCalledWith("Repeated edit"));
});

it("adopts a server refresh after saving and uses the refreshed content hash for the next save", async () => {
    const saveState = vi.fn();
    const view = (refetchKey: number) => <DocxView documentId="clean-refresh" versionId="v1" cacheBytes={false}
        defaultMode="edit" refetchKey={refetchKey} onSaveStateChange={saveState} />;
    const { rerender } = render(view(0));
    await screen.findByText("Document revision 1");
    const originalEditor = screen.getByTestId("renderer-scroll");
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(saveState).toHaveBeenLastCalledWith("clean-refresh", expect.objectContaining({ dirty: false, status: "saved" })));
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([3])));
    rerender(view(1));
    await screen.findByText("Document revision 3");
    expect(screen.getByTestId("renderer-scroll")).not.toBe(originalEditor);
    exportDocx.mockResolvedValue(new Uint8Array([43]).buffer);
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(replaceVersion).toHaveBeenCalledTimes(2));
    expect(replaceVersion.mock.calls[1][4]).toEqual({
        expectedContentSha256: createHash("sha256").update(new Uint8Array([3])).digest("hex"), generatePdf: false,
    });
});

it("retains the live editor and save baseline when a refresh contains its own saved bytes", async () => {
    const saveState = vi.fn();
    const view = (refetchKey: number) => <DocxView documentId="own-save-refresh" versionId="v1" cacheBytes={false}
        defaultMode="edit" refetchKey={refetchKey} onSaveStateChange={saveState} />;
    const { rerender } = render(view(0));
    await screen.findByText("Document revision 1");
    const originalEditor = screen.getByTestId("renderer-scroll");
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(saveState).toHaveBeenLastCalledWith("own-save-refresh", expect.objectContaining({ dirty: false, status: "saved" })));
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([42])));
    await act(async () => { rerender(view(1)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("renderer-scroll")).toBe(originalEditor);
    expect(screen.getByText("Document revision 1")).toBeVisible();
    exportDocx.mockResolvedValue(new Uint8Array([43]).buffer);
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(replaceVersion).toHaveBeenCalledTimes(2));
    expect(replaceVersion.mock.calls[1][4]).toEqual({
        expectedContentSha256: createHash("sha256").update(new Uint8Array([42])).digest("hex"), generatePdf: false,
    });
});

it("does not replay a snapshot received during a save after that save completes", async () => {
    let finish!: () => void;
    replaceVersion.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ id: "v1" }); }));
    const saveState = vi.fn();
    const view = (refetchKey: number) => <DocxView documentId="inflight-refresh" versionId="v1" cacheBytes={false}
        defaultMode="edit" refetchKey={refetchKey} onSaveStateChange={saveState} />;
    const { rerender } = render(view(0));
    await screen.findByText("Document revision 1");
    const originalEditor = screen.getByTestId("renderer-scroll");
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(replaceVersion).toHaveBeenCalledOnce());
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([2])));
    await act(async () => { rerender(view(1)); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("renderer-scroll")).toBe(originalEditor);
    await act(async () => finish());
    await waitFor(() => expect(saveState).toHaveBeenLastCalledWith("inflight-refresh", expect.objectContaining({ dirty: false, status: "saved" })));
    expect(screen.getByTestId("renderer-scroll")).toBe(originalEditor);
    expect(screen.getByText("Document revision 1")).toBeVisible();
});

it("ignores a server read started before a local save even if it arrives after the save", async () => {
    const saveState = vi.fn();
    const view = (refetchKey: number) => <DocxView documentId="late-refresh" versionId="v1" cacheBytes={false}
        defaultMode="edit" refetchKey={refetchKey} onSaveStateChange={saveState} />;
    const { rerender } = render(view(0));
    await screen.findByText("Document revision 1");
    const originalEditor = screen.getByTestId("renderer-scroll");
    let finishRead!: (response: Response) => void;
    vi.mocked(authenticatedFetch).mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    rerender(view(1));
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(saveState).toHaveBeenLastCalledWith("late-refresh", expect.objectContaining({ dirty: false, status: "saved" })));
    await act(async () => finishRead(new Response(new Uint8Array([2]))));
    expect(screen.getByTestId("renderer-scroll")).toBe(originalEditor);
    expect(screen.getByText("Document revision 1")).toBeVisible();
});
