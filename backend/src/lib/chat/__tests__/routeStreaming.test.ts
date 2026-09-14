import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { openAssistantSse } from "../routeStreaming";

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
        emit: (event: string) => {
            for (const cb of listeners[event] ?? []) cb();
        },
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

    it("aborts only when the client closes before finish()", () => {
        // This asymmetry is why routes cannot use the abort signal as their
        // late-write guard, and why the write() guard above has to exist: a
        // client that disconnects mid-stream aborts, but a route that ends its
        // own stream never does. A title promise resolving after a short
        // stream therefore sees an un-aborted signal and would write into an
        // ended response.
        const closedEarly = fakeSseResponse();
        const earlyStream = openAssistantSse(closedEarly as unknown as Response);
        closedEarly.emit("close");
        expect(earlyStream.signal.aborted).toBe(true);

        const finishedNormally = fakeSseResponse();
        const lateStream = openAssistantSse(
            finishedNormally as unknown as Response,
        );
        lateStream.finish();
        finishedNormally.emit("close");
        expect(lateStream.signal.aborted).toBe(false);
        expect(lateStream.write("data: too late\n\n")).toBe(false);
    });

    it("makes finish() idempotent so a double-end cannot throw either", () => {
        const res = fakeSseResponse();
        const sse = openAssistantSse(res as unknown as Response);

        sse.finish();
        sse.finish();

        expect(res.end).toHaveBeenCalledTimes(1);
    });
});
