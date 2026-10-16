import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabularReview } from "@/app/components/shared/types";
import { getTabularReviewHistoryStatuses } from "@/app/lib/mikeApi";
import { notifyTabularReviewsChanged } from "@/app/lib/tabularReviewChanges";
import { useTabularHistoryStatuses } from "./useTabularHistoryStatuses";

vi.mock("@/app/lib/mikeApi", () => ({ getTabularReviewHistoryStatuses: vi.fn() }));
vi.mock("@/app/lib/tabularReviewChanges", () => ({ notifyTabularReviewsChanged: vi.fn() }));
const running = [{ id: "r1", is_running: true }] as TabularReview[];
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe("tabular history status", () => {
    it("shows running through navigation, turns green on completion, and clears when opened", async () => {
        vi.mocked(getTabularReviewHistoryStatuses).mockResolvedValue([{ id: "r1", is_running: false, is_complete: true }]);
        const { result, rerender } = renderHook(({ activeId }) => useTabularHistoryStatuses(running, activeId), {
            initialProps: { activeId: "r1" as string | null },
        });
        expect(result.current.statuses.r1).toBe("loading");
        rerender({ activeId: null });
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(result.current.statuses.r1).toBe("complete");
        expect(notifyTabularReviewsChanged).toHaveBeenCalledOnce();
        act(() => result.current.clearStatus("r1"));
        expect(result.current.statuses.r1).toBeUndefined();
    });

    it.each([false, true])("does not mark a visible review as unread when completion is %s", async (is_complete) => {
        vi.mocked(getTabularReviewHistoryStatuses).mockResolvedValue([{ id: "r1", is_running: false, is_complete }]);
        const { result } = renderHook(() => useTabularHistoryStatuses(running, "r1"));
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(result.current.statuses.r1).toBeUndefined();
    });

    it("keeps loading on a transient error, then clears a failed or stopped run without marking it green", async () => {
        vi.mocked(getTabularReviewHistoryStatuses)
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValueOnce([{ id: "r1", is_running: false, is_complete: false }]);
        const { result } = renderHook(() => useTabularHistoryStatuses(running, null));
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(result.current.statuses.r1).toBe("loading");
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(result.current.statuses.r1).toBeUndefined();
    });

    it("does not poll old workspace rows and ignores an in-flight answer after switching", async () => {
        let resolve!: (value: Awaited<ReturnType<typeof getTabularReviewHistoryStatuses>>) => void;
        vi.mocked(getTabularReviewHistoryStatuses).mockReturnValueOnce(new Promise(done => { resolve = done; }));
        const { result, rerender, unmount } = renderHook(({ reviews }) => useTabularHistoryStatuses(reviews, null), {
            initialProps: { reviews: running },
        });
        await act(() => vi.advanceTimersByTimeAsync(3000));
        rerender({ reviews: [] });
        await act(async () => resolve([{ id: "r1", is_running: false, is_complete: true }]));
        expect(result.current.statuses.r1).not.toBe("complete");
        await act(() => vi.advanceTimersByTimeAsync(9000));
        expect(getTabularReviewHistoryStatuses).toHaveBeenCalledOnce();
        unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
});
