import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { authenticatedFetch } from "@/app/lib/authEvents";
import { DocxView } from "./DocxView";

vi.mock("@/app/lib/authEvents", () => ({ authenticatedFetch: vi.fn() }));
vi.mock("@/app/lib/mikeApi", () => ({
    API_BASE: "/api",
    getDocumentFileUrl: () => "/api/document/file",
}));
vi.mock("docx-preview", () => ({
    renderAsync: vi.fn(async (bytes: ArrayBuffer, container: HTMLElement) => {
        container.innerHTML = `<p>Document revision ${new Uint8Array(bytes)[0]}</p>`;
    }),
}));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.mocked(authenticatedFetch).mockReset();
});
afterEach(() => vi.unstubAllGlobals());

it("keeps the document visible during refresh, hides it on failure, and recovers", async () => {
    let fileResponse = () => Promise.resolve(new Response(new Uint8Array([1])));
    vi.mocked(authenticatedFetch).mockImplementation(async (url) => {
        if (String(url).includes("tracked-change-ids")) {
            return Response.json({ ids: [] });
        }
        return fileResponse();
    });
    const view = (refetchKey: number) => (
        <StrictMode>
            <DocxView
                documentId="doc"
                cacheBytes={false}
                refetchKey={refetchKey}
            />
        </StrictMode>
    );
    const { rerender } = render(view(0));
    const original = await screen.findByText("Document revision 1");
    expect(original).toBeVisible();

    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
        finish = resolve;
    });
    fileResponse = () => pending;
    rerender(view(1));
    expect(original).toBeVisible();
    await act(async () => finish(new Response(null, { status: 500 })));
    expect(
        await screen.findByText(
            "This document could not be loaded. Please try again.",
        ),
    ).toBeVisible();
    expect(original).not.toBeVisible();

    fileResponse = () => Promise.resolve(new Response(new Uint8Array([2])));
    rerender(view(2));
    await waitFor(() =>
        expect(screen.getByText("Document revision 2")).toBeVisible(),
    );
    expect(screen.queryByText("Document revision 1")).toBeNull();
    expect(
        screen.queryByText(
            "This document could not be loaded. Please try again.",
        ),
    ).toBeNull();
});
