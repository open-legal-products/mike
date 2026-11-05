import { describe, expect, it, vi } from "vitest";
import { createReportWindow, guardUpstreamBody, upstreamUnreachableCode } from "./upstreamFailure";

describe("upstreamUnreachableCode", () => {
    it("finds the connect code under fetch's cause and AggregateError entries", () => {
        const entry = Object.assign(new Error("connect ECONNREFUSED ::1:3001"), { code: "ECONNREFUSED" });
        const error = new TypeError("fetch failed", { cause: new AggregateError([entry], "") });
        expect(upstreamUnreachableCode(error)).toBe("ECONNREFUSED");
    });

    it("reads undici's own connect codes", () => {
        const error = new TypeError("fetch failed", {
            cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
        });
        expect(upstreamUnreachableCode(error)).toBe("UND_ERR_CONNECT_TIMEOUT");
    });

    it("is null for anything that is not a connection-level failure", () => {
        // A backend that answered late is up; a bare fetch failure has no cause.
        const slow = new TypeError("fetch failed", {
            cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
        });
        expect(upstreamUnreachableCode(slow)).toBeNull();
        expect(upstreamUnreachableCode(new TypeError("fetch failed"))).toBeNull();
        expect(upstreamUnreachableCode(new Error("API_BASE_URL is required at runtime."))).toBeNull();
        expect(upstreamUnreachableCode(undefined)).toBeNull();
    });
});

// MIKE-FRONTEND-3B: the backend closing the socket while a request body is
// still being written is the backend going away, not an application error.
it("treats EPIPE as an unreachable backend", () => {
    const failure = new TypeError("fetch failed", {
        cause: Object.assign(new Error("write EPIPE"), { code: "EPIPE" }),
    });
    expect(upstreamUnreachableCode(failure)).toBe("EPIPE");
});

describe("createReportWindow", () => {
    it("allows one report per key per window", () => {
        let now = 1_000;
        const window = createReportWindow({ windowMs: 60_000, now: () => now });
        expect(window.allow("ECONNREFUSED")).toBe(true);
        now += 59_999;
        expect(window.allow("ECONNREFUSED")).toBe(false);
        expect(window.allow("ENOTFOUND")).toBe(true);
        now += 1;
        expect(window.allow("ECONNREFUSED")).toBe(true);
        window.reset();
        expect(window.allow("ECONNREFUSED")).toBe(true);
    });

    it("defaults to a one-minute window on the wall clock", () => {
        const window = createReportWindow();
        expect(window.allow("ECONNRESET")).toBe(true);
        expect(window.allow("ECONNRESET")).toBe(false);
    });
});

describe("guardUpstreamBody", () => {
    // The consumer (Next piping to a browser that went away) can cancel while
    // a read is pending. cancel() resolves that read as done, and closing the
    // already-cancelled controller throws "Invalid state". That is not an
    // upstream failure and must not be reported as one.
    it("does not report a consumer cancel during a pending read", async () => {
        const onError = vi.fn();
        const upstream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}) });
        const reader = guardUpstreamBody(upstream, onError).getReader();

        const pending = reader.read();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await reader.cancel(new Error("client went away"));

        await expect(pending).resolves.toEqual({ done: true, value: undefined });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(onError).not.toHaveBeenCalled();
    });

    it("still reports an upstream read that fails", async () => {
        const onError = vi.fn();
        const failure = new TypeError("terminated");
        const upstream = new ReadableStream<Uint8Array>({ pull: (controller) => controller.error(failure) });
        const reader = guardUpstreamBody(upstream, onError).getReader();

        await expect(reader.read()).rejects.toMatchObject({ name: "AbortError" });
        expect(onError).toHaveBeenCalledWith(failure);
    });
});
