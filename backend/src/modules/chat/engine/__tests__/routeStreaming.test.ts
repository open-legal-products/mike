import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { openAssistantSse } from "../../../../lib/assistantSse";

function fakeSseResponse() {
    const listeners: Record<string, (() => void)[]> = {};
    const res = {
        writableEnded: false,
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn((line: string) => {
            if (res.writableEnded) {
                // Mirror Node's behavior: a write on an ended stream raises
                // ERR_STREAM_WRITE_AFTER_END asynchronously, outside any
                // try/catch surrounding the write call.
                throw Object.assign(new Error("write after end"), {
                    code: "ERR_STREAM_WRITE_AFTER_END",
                });
            }
            return true;
        }),
        end: vi.fn(() => {
            res.writableEnded = true;
        }),
        on: vi.fn((event: string, cb: () => void) => {
            (listeners[event] ??= []).push(cb);
        }),
    };
    return res;
}

describe("openAssistantSse", () => {
    it("drops writes that arrive after finish() instead of raising write-after-end", () => {
        const res = fakeSseResponse();
        const sse = openAssistantSse(res as unknown as Response);

        expect(sse.write("data: hello\n\n")).toBe(true);
        sse.finish();

        // The late line from a racing error handler must be dropped, not
        // handed to an ended stream.
        expect(sse.write("data: too late\n\n")).toBe(false);
        expect(res.write).toHaveBeenCalledTimes(1);
    });

    it("makes finish() idempotent so a double-end cannot throw either", () => {
        const res = fakeSseResponse();
        const sse = openAssistantSse(res as unknown as Response);

        sse.finish();
        sse.finish();

        expect(res.end).toHaveBeenCalledTimes(1);
    });
});
