import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    getPlaybookRunStatuses,
    type PlaybookRunHistoryItem,
} from "@/app/lib/mikeApi";
import { subscribePlaybookRunChanges } from "@/app/lib/playbookRunActivity";
import { usePlaybookRunHistoryStatuses } from "./usePlaybookRunHistoryStatuses";

vi.mock("@/app/lib/mikeApi", () => ({ getPlaybookRunStatuses: vi.fn() }));

const run = (id: string, status: string) => ({
    id, playbookId: "pb", playbookName: "MSA", documentName: `${id}.docx`,
    status, error: null, startedAt: "2026-10-18T00:00:00Z", completedAt: null,
}) as PlaybookRunHistoryItem;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("usePlaybookRunHistoryStatuses", () => {
    it("spins while a run runs, then ticks until its results are viewed", async () => {
        const changed = vi.fn();
        const unsubscribe = subscribePlaybookRunChanges(changed);
        // History's list is a stable array until it refreshes.
        const runs = [run("a", "running"), run("b", "completed")];
        const { result, rerender } = renderHook(
            ({ viewed }) => usePlaybookRunHistoryStatuses(runs, viewed),
            { initialProps: { viewed: null as string | null } },
        );
        // A run already finished before it was seen gets no tick.
        expect(result.current.statuses).toEqual({ a: "loading" });

        vi.mocked(getPlaybookRunStatuses).mockResolvedValue([
            { id: "a", status: "completed", completedAt: "2026-10-18T00:01:00Z" },
        ]);
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(getPlaybookRunStatuses).toHaveBeenCalledWith(["a"], expect.any(AbortSignal));
        expect(result.current.statuses).toEqual({ a: "complete" });
        expect(changed).toHaveBeenCalled();

        rerender({ viewed: "a" });
        expect(result.current.statuses).toEqual({});
        unsubscribe();
    });

    it("gives no tick to a run finished while viewed, or to a failed run", async () => {
        const runs = [run("seen", "running"), run("broken", "running")];
        const { result } = renderHook(() => usePlaybookRunHistoryStatuses(runs, "seen"));
        vi.mocked(getPlaybookRunStatuses).mockResolvedValue([
            { id: "seen", status: "completed", completedAt: null },
            { id: "broken", status: "failed", completedAt: null },
        ]);
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(result.current.statuses).toEqual({});
    });

    it("keeps spinning when a status check fails", async () => {
        const runs = [run("a", "running")];
        const { result } = renderHook(() => usePlaybookRunHistoryStatuses(runs, null));
        vi.mocked(getPlaybookRunStatuses).mockRejectedValue(new Error("offline"));
        await act(() => vi.advanceTimersByTimeAsync(3000));
        expect(result.current.statuses).toEqual({ a: "loading" });
    });
});
