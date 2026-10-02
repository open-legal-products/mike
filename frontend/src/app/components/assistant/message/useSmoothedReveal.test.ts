import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useSmoothedReveal } from "./useSmoothedReveal";

const FULL = "**Demo mode** — no AI provider key is configured.";

describe("useSmoothedReveal", () => {
    it("snaps to the full text when the stream ends mid-reveal", async () => {
        // Stream a long body in one chunk while active: the rAF pacer will only
        // have revealed a prefix by the time the stream ends.
        const { result, rerender } = renderHook(
            ({ text, active }) => useSmoothedReveal(text, active),
            { initialProps: { text: "", active: true } },
        );

        rerender({ text: FULL, active: true });
        expect(result.current.length).toBeLessThan(FULL.length);

        // Stream ends. The hook must snap to the full text — it drives the
        // rendered slice off `revealedInt`, so updating only the internal ref
        // would leave the reply frozen at a partial prefix (e.g. "**Demo mo").
        await act(async () => {
            rerender({ text: FULL, active: false });
        });

        expect(result.current).toBe(FULL);
    });

    it("returns the full text immediately for a replayed (non-streaming) message", () => {
        const { result } = renderHook(() => useSmoothedReveal(FULL, false));
        expect(result.current).toBe(FULL);
    });

    it("never returns more than the text it was given", async () => {
        const { result, rerender } = renderHook(
            ({ text, active }) => useSmoothedReveal(text, active),
            { initialProps: { text: FULL, active: false } },
        );

        // Text replaced by something shorter (edited / retried turn).
        await act(async () => {
            rerender({ text: "short", active: false });
        });

        expect(result.current).toBe("short");
    });
});


describe("reveal scheduler under sustained updates", () => {
    let now: number;
    let frames: Map<number, FrameRequestCallback>;
    let nextId: number;
    const frame = (time: number) => {
        now = time;
        act(() => {
            const callbacks = [...frames.values()];
            frames.clear();
            callbacks.forEach((callback) => callback(now));
        });
    };
    beforeEach(() => {
        now = 0;
        nextId = 0;
        frames = new Map();
        vi.spyOn(performance, "now").mockImplementation(() => now);
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            frames.set(++nextId, callback);
            return nextId;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    });
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

    it("keeps elapsed animation time when chunks arrive just before a frame", () => {
        const { result, rerender } = renderHook(
            ({ text }) => useSmoothedReveal(text, true),
            { initialProps: { text: "" } },
        );
        rerender({ text: "x".repeat(100) });
        for (let tick = 1; tick <= 120; tick++) {
            now = tick * 16 - 1;
            rerender({ text: "x".repeat(100 + tick) });
            frame(tick * 16);
        }
        // About two seconds have elapsed. Frequent deltas must not reduce
        // each frame to only its final millisecond and hold the reply back.
        expect(result.current.length).toBeGreaterThan(170);
        expect(frames.size).toBeLessThanOrEqual(1);
    });

    it("sleeps when caught up, wakes on a new chunk and cancels on unmount", () => {
        const { result, rerender, unmount } = renderHook(
            ({ text }) => useSmoothedReveal(text, true),
            { initialProps: { text: "" } },
        );
        expect(frames.size).toBe(0);
        rerender({ text: "hello" });
        frame(500);
        expect(result.current).toBe("hello");
        expect(frames.size).toBe(0);
        now = 800;
        rerender({ text: "hello again" });
        expect(frames.size).toBe(1);
        unmount();
        expect(frames.size).toBe(0);
    });

    it("resumes from the latest inactive text and clamps a shorter replacement", () => {
        const { result, rerender } = renderHook(
            ({ text, active }) => useSmoothedReveal(text, active),
            { initialProps: { text: "", active: true } },
        );
        rerender({ text: "completed history", active: false });
        rerender({ text: "completed history plus", active: true });
        expect(result.current).toBe("completed history");
        rerender({ text: "short", active: true });
        expect(result.current).toBe("short");
        expect(frames.size).toBe(0);
    });
});
