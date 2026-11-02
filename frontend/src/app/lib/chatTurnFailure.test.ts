import { describe, expect, it } from "vitest";
import { MikeApiError } from "@/app/lib/mikeApi";
import {
    TURN_FAILED_MESSAGE,
    errorFrameFailure,
    isUncertainDelivery,
} from "./chatTurnFailure";

describe("isUncertainDelivery", () => {
    it("treats only an explicit 4xx as proof nothing was stored", () => {
        expect(isUncertainDelivery(new TypeError("Failed to fetch"), false)).toBe(true);
        expect(isUncertainDelivery(new MikeApiError({ message: "down", status: 502 }), false)).toBe(true);
        expect(isUncertainDelivery(new MikeApiError({ message: "busy", status: 429 }), false)).toBe(false);
    });

    it("is never uncertain once the server has named the turn", () => {
        expect(isUncertainDelivery(new TypeError("Failed to fetch"), true)).toBe(false);
    });
});

describe("errorFrameFailure", () => {
    it("keeps a safe refusal verbatim and does not offer a retry", () => {
        const failure = errorFrameFailure(" Add an API key. ", true);
        expect(failure.message).toBe("Add an API key.");
        expect(failure.retryable).toBe(false);
    });

    it("replaces internal text and stays retryable", () => {
        const failure = errorFrameFailure("provider exploded: stack", false);
        expect(failure.message).toBe(TURN_FAILED_MESSAGE);
        expect(failure.retryable).toBe(true);
    });

    it("carries the frame's code and request id for the report, never the message", () => {
        const failure = errorFrameFailure("provider exploded", false, {
            code: "internal_error",
            requestId: "req-1",
        });
        expect(failure).toMatchObject({ code: "internal_error", requestId: "req-1" });
        expect(failure.message).toBe(TURN_FAILED_MESSAGE);
        // Absent or malformed fields leave the error without them.
        const bare = errorFrameFailure("x", false, { code: 7, requestId: "" });
        expect("code" in bare).toBe(false);
        expect("requestId" in bare).toBe(false);
    });
});
