import { describe, expect, it } from "vitest";
import { createReportWindow, upstreamUnreachableCode } from "./upstreamFailure";

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
