import type { Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    reportError,
}));

import { AppError } from "../../../../lib/appError";
import { openAssistantSse } from "../../../../lib/assistantSse";
import { logAssistantMessageFailure, requestIdOf } from "../routeStreaming";

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

describe("logAssistantMessageFailure", () => {
    beforeEach(() => {
        reportError.mockClear();
    });

    it("reports a PostgREST error wrapped in the kind, then logs that same object", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const postgrest = { code: "23503", message: "violates foreign key", details: "Key (chat_id)" };

        const failure = logAssistantMessageFailure({
            kind: "chat.message_save_failed",
            label: "[chat/stream] failed to save assistant response",
            cause: postgrest,
            component: "chat-stream",
        });

        expect(failure).toBeInstanceOf(AppError);
        expect(failure.kind).toBe("chat.message_save_failed");
        expect(failure.cause).toBe(postgrest);
        // Reported before it is logged, so the console bridge sees a known object.
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(failure, { tags: { component: "chat-stream" } });
        expect(errorSpy).toHaveBeenCalledWith(
            "[chat/stream] failed to save assistant response",
            failure,
        );
        expect(reportError.mock.invocationCallOrder[0]).toBeLessThan(
            errorSpy.mock.invocationCallOrder[0]!,
        );
        errorSpy.mockRestore();
    });

    it("keeps an error that already names its kind", () => {
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const named = new AppError("chat.message_reserve_failed", "reserve");

        const failure = logAssistantMessageFailure({
            kind: "chat.message_save_failed",
            label: "[word-chat] failed to reserve assistant message",
            cause: named,
            component: "word-chat",
        });

        expect(failure).toBe(named);
        expect(reportError).toHaveBeenCalledWith(named, { tags: { component: "word-chat" } });
        errorSpy.mockRestore();
    });
});

describe("requestIdOf", () => {
    it("reads the request id the middleware stored, and nothing else", () => {
        expect(requestIdOf({ locals: { requestId: "req-1" } })).toBe("req-1");
        expect(requestIdOf({ locals: {} })).toBeUndefined();
        expect(requestIdOf({ locals: { requestId: 42 } })).toBeUndefined();
    });
});
