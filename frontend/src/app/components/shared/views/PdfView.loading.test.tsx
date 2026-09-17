import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocResult } from "@/app/hooks/useFetchSingleDoc";
import { PdfView } from "./PdfView";

const mocks = vi.hoisted(() => ({
    result: null as DocResult,
    getDocument: vi.fn(),
    textCleanup: vi.fn(),
}));
vi.mock("@/app/hooks/useFetchSingleDoc", () => ({
    useFetchSingleDoc: () => ({
        result: mocks.result,
        loading: false,
        error: null,
    }),
}));
vi.mock("./highlightQuote", () => ({
    getPdfJs: async () => ({
        getDocument: mocks.getDocument,
        TextLayer: { cleanup: mocks.textCleanup },
    }),
    clearHighlights: vi.fn(),
    highlightQuote: vi.fn(),
    STANDARD_FONT_DATA_URL: "/standard_fonts/",
}));

const pdfDocument = {
    numPages: 1,
    getPage: vi
        .fn()
        .mockResolvedValue({
            getViewport: () => ({ width: 100, height: 100 }),
        }),
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.result = {
        type: "pdf",
        buffer: Uint8Array.from([37, 80, 68, 70]).buffer,
    };
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            disconnect() {}
        },
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const view = () => <PdfView doc={{ document_id: "document-1" }} />;

describe("PdfView loading", () => {
    it("keeps fetched bytes attached when PDF.js transfers its buffer and loads the same bytes again", async () => {
        const source = Uint8Array.from([37, 80, 68, 70]).buffer;
        mocks.result = { type: "pdf", buffer: source };
        const workerBytes: number[][] = [];
        const transferred: ArrayBuffer[] = [];
        const destroy = vi.fn().mockResolvedValue(undefined);
        mocks.getDocument.mockImplementation(
            ({ data }: { data: Uint8Array }) => {
                workerBytes.push(Array.from(data));
                transferred.push(data.buffer as ArrayBuffer);
                // Reproduce PDF.js worker ownership with an actual transfer.
                structuredClone(data.buffer, { transfer: [data.buffer] });
                return { promise: Promise.resolve(pdfDocument), destroy };
            },
        );
        const { rerender, unmount } = render(view());
        await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1));
        expect(transferred[0].byteLength).toBe(0);
        expect(source.byteLength).toBe(4);
        expect(Array.from(new Uint8Array(source))).toEqual([37, 80, 68, 70]);
        mocks.result = { type: "pdf", buffer: source };
        rerender(view());
        await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2));
        expect(workerBytes).toEqual([
            [37, 80, 68, 70],
            [37, 80, 68, 70],
        ]);
        expect(transferred[1]).not.toBe(transferred[0]);
        expect(transferred[1].byteLength).toBe(0);
        expect(source.byteLength).toBe(4);
        expect(screen.queryByText("Failed to load document.")).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
        unmount();
        expect(destroy).toHaveBeenCalledTimes(2);
    });

    it("shows a safe message for PDF loading failures and clears it for another document", async () => {
        mocks.getDocument.mockReturnValueOnce({
            promise: Promise.reject(new Error("private worker exception")),
            destroy: vi.fn().mockResolvedValue(undefined),
        });
        const { rerender } = render(view());
        expect(
            await screen.findByText("Failed to load document."),
        ).toBeVisible();
        expect(screen.queryByText("private worker exception")).toBeNull();
        mocks.result = null;
        rerender(<PdfView doc={{ document_id: "document-2" }} />);
        expect(screen.queryByText("Failed to load document.")).toBeNull();
        mocks.getDocument.mockReturnValueOnce({
            promise: Promise.resolve(pdfDocument),
            destroy: vi.fn().mockResolvedValue(undefined),
        });
        mocks.result = { type: "pdf", buffer: new ArrayBuffer(4) };
        rerender(<PdfView doc={{ document_id: "document-2" }} />);
        await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2));
        expect(screen.queryByText("Failed to load document.")).toBeNull();
    });

    it("destroys a cancelled load and ignores its rejection after a new document has loaded", async () => {
        let rejectOld!: (error: Error) => void;
        const destroyOld = vi.fn().mockResolvedValue(undefined);
        mocks.getDocument.mockReturnValueOnce({
            promise: new Promise((_resolve, reject) => {
                rejectOld = reject;
            }),
            destroy: destroyOld,
        });
        const { rerender } = render(view());
        await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1));
        mocks.getDocument.mockReturnValueOnce({
            promise: Promise.resolve(pdfDocument),
            destroy: vi.fn().mockResolvedValue(undefined),
        });
        mocks.result = { type: "pdf", buffer: new ArrayBuffer(4) };
        rerender(<PdfView doc={{ document_id: "document-2" }} />);
        await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(2));
        expect(destroyOld).toHaveBeenCalledOnce();
        await act(async () => {
            rejectOld(new Error("Cancelled load"));
        });
        expect(screen.queryByText("Failed to load document.")).toBeNull();
    });
});
