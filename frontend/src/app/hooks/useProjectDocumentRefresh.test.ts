import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useProjectDocumentRefresh } from "./useProjectDocumentRefresh";

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("useProjectDocumentRefresh", () => {
    it("throttles the initial check through StrictMode setup and checks after the gap", async () => {
        const refresh = vi.fn().mockResolvedValue(undefined);
        renderHook(() => useProjectDocumentRefresh(refresh, "pdf"), {
            wrapper: StrictMode,
        });
        expect(refresh).not.toHaveBeenCalled();
        act(() => {
            vi.advanceTimersByTime(29_999);
            window.dispatchEvent(new Event("focus"));
        });
        expect(refresh).not.toHaveBeenCalled();
        await act(async () => {
            vi.advanceTimersByTime(1);
            window.dispatchEvent(new Event("focus"));
        });
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it("checks on returning to an open tab, throttles duplicate focus events, and stops after closing", async () => {
        const refresh = vi.fn().mockResolvedValue(undefined);
        const { rerender, unmount } = renderHook(
            ({ id }) => useProjectDocumentRefresh(refresh, id),
            { initialProps: { id: null as string | null } },
        );
        act(() => vi.advanceTimersByTime(60_000));
        expect(refresh).not.toHaveBeenCalled();
        await act(async () => rerender({ id: "pdf" }));
        expect(refresh).toHaveBeenCalledTimes(1);
        act(() => {
            window.dispatchEvent(new Event("focus"));
            document.dispatchEvent(new Event("visibilitychange"));
            rerender({ id: "sheet" });
        });
        expect(refresh).toHaveBeenCalledTimes(1);
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(refresh).toHaveBeenCalledTimes(2);
        act(() => rerender({ id: null }));
        act(() => {
            vi.advanceTimersByTime(120_000);
            window.dispatchEvent(new Event("focus"));
        });
        expect(refresh).toHaveBeenCalledTimes(2);
        unmount();
    });

    it("pauses when hidden, shares pending checks, and recovers after failure", async () => {
        let finish!: () => void;
        const refresh = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockRejectedValueOnce(new Error("offline"))
            .mockResolvedValue(undefined);
        let visibility = "hidden";
        vi.spyOn(document, "visibilityState", "get").mockImplementation(
            () => visibility as DocumentVisibilityState,
        );
        const { unmount } = renderHook(() =>
            useProjectDocumentRefresh(refresh, "pdf"),
        );
        act(() => vi.advanceTimersByTime(60_000));
        expect(refresh).not.toHaveBeenCalled();
        visibility = "visible";
        act(() => document.dispatchEvent(new Event("visibilitychange")));
        expect(refresh).toHaveBeenCalledTimes(1);
        act(() => vi.advanceTimersByTime(120_000));
        expect(refresh).toHaveBeenCalledTimes(1);
        await act(async () => finish());
        await act(async () => window.dispatchEvent(new Event("focus")));
        expect(refresh).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(refresh).toHaveBeenCalledTimes(3);
        unmount();
    });
});
