import { useLayoutEffect } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useDocumentViewers } from "./useDocumentViewers";
import { downloadDocumentFile } from "@/app/lib/downloadDocument";
vi.mock("@/app/lib/downloadDocument", () => ({ downloadDocumentFile: vi.fn() }));
function setup() {
    let viewers!: ReturnType<typeof useDocumentViewers>;
    render(<Harness />);
    function Harness() { const value = useDocumentViewers(); useLayoutEffect(() => { viewers = value; }); return value.confirmation; }
    return () => viewers;
}
it("waits for saving, keeps failed drafts on cancel, and discards only after confirmation", async () => {
    const viewers = setup(); const close = vi.fn(); const discard = vi.fn();
    const prepareClose = vi.fn().mockResolvedValue(false);
    viewers().registerCloseGuard("doc", { hasUnsavedChanges: () => true, prepareClose, discard });
    await act(async () => viewers().requestClose(["doc"], close));
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(discard).not.toHaveBeenCalled();
    await act(async () => viewers().requestClose(["doc"], close));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(discard).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it("closes after a successful save and handles all selected documents", async () => {
    const viewers = setup(); const close = vi.fn();
    let finish!: (saved: boolean) => void;
    viewers().registerCloseGuard("doc", { hasUnsavedChanges: () => true, prepareClose: () => new Promise(resolve => { finish = resolve; }), discard: vi.fn() });
    act(() => viewers().requestClose(["doc"], close));
    expect(close).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(close).toHaveBeenCalledOnce();
});
it("shares the live download lookup and falls back to the requested server version", async () => {
    const viewers = setup(); const live = vi.fn().mockResolvedValue(undefined);
    viewers().registerDownload("tab", live);
    await viewers().download("tab", "doc", "v", "file.docx");
    expect(live).toHaveBeenCalledOnce();
    viewers().registerDownload("tab", null);
    await viewers().download("tab", "doc", "v", "file.docx");
    expect(downloadDocumentFile).toHaveBeenCalledWith("doc", "v", "file.docx");
});
