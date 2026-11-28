import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsDesktop } from "./useIsDesktop";

afterEach(() => vi.unstubAllGlobals());

function stubMatchMedia(initial: boolean) {
    let matches = initial;
    let listener: (() => void) | null = null;
    vi.stubGlobal(
        "matchMedia",
        vi.fn(() => ({
            get matches() {
                return matches;
            },
            addEventListener: (_: string, cb: () => void) => {
                listener = cb;
            },
            removeEventListener: () => {
                listener = null;
            },
        })),
    );
    return (next: boolean) => {
        matches = next;
        act(() => listener?.());
    };
}

describe("useIsDesktop", () => {
    it("follows the md breakpoint as the window resizes", () => {
        const resize = stubMatchMedia(false);
        const { result } = renderHook(() => useIsDesktop());
        expect(result.current).toBe(false);
        resize(true);
        expect(result.current).toBe(true);
        expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
    });

    it("assumes the wide layout without matchMedia", () => {
        vi.stubGlobal("matchMedia", undefined);
        const { result } = renderHook(() => useIsDesktop());
        expect(result.current).toBe(true);
    });
});
