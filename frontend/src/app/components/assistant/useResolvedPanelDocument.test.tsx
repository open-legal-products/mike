import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPanelDocument } from "@/app/lib/mikeApi";
import { useResolvedPanelDocument } from "./useResolvedPanelDocument";

vi.mock("@/app/lib/mikeApi", () => ({
    getPanelDocument: vi.fn(),
}));

const getPanelDocumentMock = vi.mocked(getPanelDocument);
const summary = {
    document_id: "case:123",
    title: "Example v Example, 123 U.S. 456",
    type: "case" as const,
    metadata: [],
    quotes: [
        {
            quote: "Verified passage",
            verification: { verified: true },
            target: { subdocument_id: "case:123:opinion:1" },
        },
    ],
};

describe("useResolvedPanelDocument", () => {
    beforeEach(() => {
        getPanelDocumentMock.mockReset();
    });

    it("hydrates missing case content while preserving citation quotes", async () => {
        getPanelDocumentMock.mockResolvedValue({
            ...summary,
            title: "Provider title",
            quotes: [],
            subdocuments: [
                {
                    document_id: "case:123:opinion:1",
                    title: "Lead Opinion",
                    type: "html",
                    html: "<p>Verified passage</p>",
                },
            ],
        });

        const { result } = renderHook(() => useResolvedPanelDocument(summary));

        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.document.title).toBe(summary.title);
        expect(result.current.document.quotes).toEqual(summary.quotes);
        expect(result.current.document.subdocuments).toHaveLength(1);
    });

    it("updates quotes without refetching the same case when its summary changes", async () => {
        getPanelDocumentMock.mockResolvedValue({
            ...summary,
            subdocuments: [
                {
                    document_id: "opinion",
                    title: "Opinion",
                    type: "html",
                    html: "<p>Case content</p>",
                },
            ],
        });
        const { result, rerender } = renderHook(
            ({ document }) => useResolvedPanelDocument(document),
            {
                initialProps: { document: summary },
            },
        );
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        const updated = {
            ...summary,
            quotes: [{ ...summary.quotes[0], quote: "Another passage" }],
        };
        rerender({ document: updated });
        expect(result.current.document.quotes).toEqual(updated.quotes);
        expect(result.current.document.subdocuments).toHaveLength(1);
        expect(getPanelDocumentMock).toHaveBeenCalledOnce();
    });

    it("retries a failed hydration request", async () => {
        getPanelDocumentMock
            .mockRejectedValueOnce(new Error("temporary failure"))
            .mockResolvedValueOnce({
                ...summary,
                quotes: [],
                subdocuments: [
                    {
                        document_id: "case:123:opinion:1",
                        title: "Lead Opinion",
                        type: "html",
                        text: "Loaded on retry",
                    },
                ],
            });

        const { result } = renderHook(() => useResolvedPanelDocument(summary));
        await waitFor(() => expect(result.current.error).not.toBeNull());

        act(() => result.current.retry());

        await waitFor(() =>
            expect(result.current.document.subdocuments).toHaveLength(1),
        );
        expect(getPanelDocumentMock).toHaveBeenCalledTimes(2);
        expect(result.current.error).toBeNull();
    });
});
