import { StrictMode, useEffect, useRef } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import type { DocxRendererProps } from "./DocxRenderer.types";
import { DocxView } from "./DocxView";

const exportDocx = vi.hoisted(() => vi.fn());

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({ getDocumentFileUrl: (id: string) => "/api/document/" + id }));
vi.mock("./EigenpalDocxRenderer", () => ({
    default: (props: DocxRendererProps) => <MockRenderer {...props} />,
}));

function MockRenderer({ bytes, mode, onChange, onReady, onError, onSave }: DocxRendererProps) {
    const scroll = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);
    const revision = new Uint8Array(bytes)[0];
    useEffect(() => {
        if (revision === 99) onError();
        else if (scroll.current && content.current) onReady({ scroll: scroll.current, content: content.current, exportDocx });
    }, [bytes, onReady, onError, revision]);
    return (
        <div ref={scroll} data-testid="renderer-scroll" data-mode={mode}>
            {mode === "edit" && <div role="toolbar" aria-label="Document formatting"><button onClick={onChange}>Change document</button></div>}
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
    exportDocx.mockReset().mockResolvedValue(new Uint8Array([42]).buffer);
    vi.mocked(authenticatedFetch).mockReset();
    vi.mocked(authenticatedFetch).mockResolvedValue(new Response(new Uint8Array([1])));
    HTMLElement.prototype.scrollTo = vi.fn(function (this: HTMLElement, options?: ScrollToOptions | number) {
        this.scrollTop = typeof options === "number" ? 0 : options?.top ?? 0;
    });
});
afterEach(() => { HTMLElement.prototype.scrollTo = originalScrollTo; vi.restoreAllMocks(); });

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
    expect(scroll.scrollTop).toBe(240);
    scroll.scrollTop = 320;
    fireEvent.scroll(scroll);
    await waitFor(() => expect(onScrollChange).toHaveBeenCalledWith(320));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
});

it("retains multiple citation highlights and uses native revision IDs", async () => {
    const { container } = render(<DocxView documentId="quotes" cacheBytes={false}
        quotes={[{ quote: "Payment in thirty days." }, { quote: "Confidential information." }]}
        highlightEdit={{ key: "edit-8", ins_w_id: "8", inserted_text: "Repeated edit" }} />);
    await screen.findByText("EigenPal preview");
    expect(container.querySelectorAll(".docx-text-highlight")).toHaveLength(2);
    expect(container.querySelector('[data-revision-id="8"]')).toHaveClass("docx-edit-flash");
    expect(container.querySelector('[data-revision-id="7"]')).not.toHaveClass("docx-edit-flash");
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
    const createUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:edited-document");
    const revokeUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    exportDocx.mockRejectedValueOnce(new Error("internal serializer details"));
    render(<DocxView documentId="export" filename="Agreement.docx" cacheBytes={false} defaultMode="edit" />);
    await screen.findByText("EigenPal preview");
    fireEvent.click(screen.getByRole("button", { name: "Change document" }));
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    expect(await screen.findByText(/Your edits are still open/)).toBeVisible();
    const unsaved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
    expect(screen.queryByText(/internal serializer/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    expect(createUrl).toHaveBeenCalledWith(expect.any(Blob));
    expect(click.mock.instances[0]).toHaveAttribute("download", "Agreement.docx");
    expect(exportDocx).toHaveBeenCalledTimes(2);
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
    // Cleanup's revoke timeout can run after the test restores its mocks.
    revokeUrl.mockRestore();
});

it("re-centers a citation after the engine restores scroll during page paint", async () => {
    let firstScroll = true;
    vi.mocked(HTMLElement.prototype.scrollTo).mockImplementation(function (this: HTMLElement) {
        this.scrollTop = 0;
        if (firstScroll) {
            firstScroll = false;
            requestAnimationFrame(() => { this.scrollTop = 500; });
        }
    });
    render(<DocxView documentId="paint-settle" cacheBytes={false}
        quotes={[{ quote: "Payment in thirty days." }]} />);
    await screen.findByText("EigenPal preview");
    await waitFor(() => expect(vi.mocked(HTMLElement.prototype.scrollTo).mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(screen.getByTestId("renderer-scroll").scrollTop).toBe(0);
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
