import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameBatcher } from "./frameBatcher";

describe("createFrameBatcher", () => {
    afterEach(() => vi.useRealTimers());

    it("applies a burst once per frame and flushes the rest on demand", () => {
        vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
        const apply = vi.fn();
        const batcher = createFrameBatcher<number>(apply);
        batcher.push(1);
        batcher.push(2);
        expect(apply).not.toHaveBeenCalled();
        vi.advanceTimersToNextFrame();
        expect(apply).toHaveBeenCalledExactlyOnceWith([1, 2]);

        batcher.push(3);
        batcher.flush();
        expect(apply).toHaveBeenLastCalledWith([3]);
        vi.advanceTimersToNextFrame();
        batcher.flush();
        expect(apply).toHaveBeenCalledTimes(2);
    });
});
