import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VisualView } from "./VisualView";

const mocks = vi.hoisted(() => ({
    bytes: null as ArrayBuffer | null,
    getVisualSnapshot: vi.fn(),
    downloadBlob: vi.fn(),
}));
vi.mock("@/app/hooks/useFetchDocxBytes", () => ({
    useFetchDocxBytes: () => ({ bytes: mocks.bytes, loading: false, error: null }),
}));
vi.mock("@/app/lib/mikeApi", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/app/lib/mikeApi")>()),
    getVisualSnapshot: (...args: unknown[]) => mocks.getVisualSnapshot(...args),
}));
vi.mock("@/app/lib/downloadDocument", () => ({
    downloadBlob: (...args: unknown[]) => mocks.downloadBlob(...args),
}));

const html = '<html data-theme="light"><body><p>Rent by year</p></body></html>';

beforeEach(() => {
    mocks.bytes = new TextEncoder().encode(html).buffer as ArrayBuffer;
    mocks.getVisualSnapshot.mockResolvedValue({
        created_at: "2026-10-20T14:32:00Z",
        sources: [
            { document_id: "doc-1", filename: "Lease schedule.xlsx", stale: false },
            { document_id: "doc-2", filename: "Review memo.pdf", stale: false },
        ],
    });
});
afterEach(() => {
    vi.clearAllMocks();
});

describe("VisualView loading", () => {
    it("decodes the fetched html into the sandboxed frame and offers the html download", async () => {
        const onDownloadReady = vi.fn();
        render(
            <VisualView
                documentId="visual-1"
                versionId="v1"
                filename="rent-chart.html"
                onDownloadReady={onDownloadReady}
            />,
        );

        const frame = screen.getByTitle("rent-chart.html") as HTMLIFrameElement;
        expect(frame.getAttribute("srcdoc")).toContain("<p>Rent by year</p>");
        expect(mocks.getVisualSnapshot).toHaveBeenCalledWith("visual-1", "v1", expect.any(AbortSignal));

        const download = onDownloadReady.mock.calls.at(-1)?.[0] as () => Promise<void>;
        await download();
        const [blob, filename] = mocks.downloadBlob.mock.calls[0] as [Blob, string];
        expect(filename).toBe("rent-chart.html");
        expect(await blob.text()).toBe(html);
        expect(screen.queryByText(/A source has changed/)).toBeNull();
    });

    it("shows the stale notice when the snapshot reports a changed source", async () => {
        mocks.getVisualSnapshot.mockResolvedValue({
            created_at: null,
            sources: [{ document_id: "doc-1", filename: "Lease schedule.xlsx", stale: true }],
        });
        render(<VisualView documentId="visual-1" filename="rent-chart.html" />);

        await waitFor(() =>
            expect(
                screen.getByText("A source has changed since this was made. Ask Mike to update it."),
            ).toBeInTheDocument(),
        );
    });
});
