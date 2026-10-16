/**
 * How a Word turn's terminal `error` frame is classified.
 *
 * Fail-without-fix: the class hard-coded `kind: "server"` and
 * `retryable: true`, and the frame's `safe_to_display`/`code` were dropped.
 * A rejected API key therefore produced a toast offering "Retry" (which
 * re-sends the whole turn and fails identically) and "Contact support" for
 * a key only the user can fix.
 */
import { describe, expect, it } from "vitest";
import { describeError } from "@/shared/lib/userError";
import { terminalErrorFromFrame } from "../../../word-addin/src/taskpane/lib/wordChatTerminalError";

describe("terminalErrorFromFrame", () => {
    it("keeps a generic server failure retryable and supportable", () => {
        const described = describeError(
            terminalErrorFromFrame({
                type: "error",
                message: "The response could not be completed. Please try again.",
            }),
        );
        expect(described.kind).toBe("server");
        expect(described.retryable).toBe(true);
        expect(described.supportable).toBe(true);
        expect(described.message).toBe(
            "The response could not be completed. Please try again.",
        );
    });

    it("does not offer Retry or support for the user's own key problem", () => {
        const error = terminalErrorFromFrame({
            type: "error",
            message: "Your Anthropic API key was rejected. Update it in Settings.",
            safe_to_display: true,
            code: "invalid_api_key",
        });
        const described = describeError(error);
        expect(described.retryable).toBe(false);
        expect(described.supportable).toBe(false);
        expect(described.code).toBe("invalid_api_key");
        expect(described.message).toBe(
            "Your Anthropic API key was rejected. Update it in Settings.",
        );
    });

    it("treats a safe message without a code the same way", () => {
        const described = describeError(
            terminalErrorFromFrame({
                type: "error",
                message: "That model is not available on your plan.",
                safe_to_display: true,
            }),
        );
        expect(described.retryable).toBe(false);
    });

    it("never shows a placeholder when the frame has no message", () => {
        const error = terminalErrorFromFrame({ type: "error" });
        expect(error.message).toBe(
            "The response could not be completed. Please try again.",
        );
        expect(error.retryable).toBe(true);
    });
});
