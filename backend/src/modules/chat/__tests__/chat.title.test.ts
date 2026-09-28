import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeText, reportError } = vi.hoisted(() => ({
    completeText: vi.fn(),
    reportError: vi.fn(() => null),
}));

vi.mock("../../../lib/llm", () => ({ completeText }));
vi.mock("../../../lib/observability/sentry", () => ({ reportError }));

import { generateAssistantChatTitle, logChatTitleFailure } from "../chat.title";
import { UserFacingError } from "../../../lib/userFacingError";

describe("logChatTitleFailure", () => {
    const apiCallError = (statusCode: number) =>
        Object.assign(new Error("provider answered"), {
            name: "AI_APICallError",
            statusCode,
        });
    // What the reply throws for the same rejected key: the route's wrapper,
    // whose cause chain ends in the provider's answer.
    const replyRejectedKey = () =>
        new Error("stream failed", {
            cause: new UserFacingError("The Gemini API key was rejected.", {
                cause: apiCallError(400),
            }),
        });

    beforeEach(() => {
        reportError.mockClear();
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    // console.error is what the Sentry console bridge files; console.warn is
    // not. When the reply failed the same way, its report already covers the
    // title, so filing the title too duplicated it (MIKE-BACKEND-D).
    it("keeps a title failure the reply shares out of Sentry", () => {
        logChatTitleFailure("[t]", apiCallError(400), replyRejectedKey());
        expect(reportError).not.toHaveBeenCalled();
        expect(console.error).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("treats a missing key as shared when the reply refused for configuration too", () => {
        logChatTitleFailure(
            "[t]",
            new UserFacingError("Gemini API key required"),
            new Error("stream failed", {
                cause: new UserFacingError("Gemini API key required"),
            }),
        );
        expect(reportError).not.toHaveBeenCalled();
    });

    // A separately configured title model, or a rate limit only the short
    // title call hit: the reply succeeded, so nothing else reports this.
    it("reports a title-only provider failure once, as a warning", () => {
        const retryError = Object.assign(new Error("retries exhausted"), {
            name: "AI_RetryError",
            lastError: Object.assign(new Error("rate limited"), {
                name: "AI_APICallError",
                statusCode: 429,
            }),
        });
        logChatTitleFailure("[t]", retryError, null);
        expect(reportError).toHaveBeenCalledTimes(1);
        expect(reportError).toHaveBeenCalledWith(retryError, {
            level: "warning",
            tags: { component: "chat-title" },
        });
        expect(console.error).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it("reports a title failure that differs from the reply's failure", () => {
        // Reply: rejected key (400). Title: a different provider is overloaded.
        logChatTitleFailure("[t]", apiCallError(503), replyRejectedKey());
        expect(reportError).toHaveBeenCalledTimes(1);
    });

    it("still logs anything else — a failed title write, a bug — as an error", () => {
        const bug = new TypeError("cannot read properties of undefined");
        logChatTitleFailure("[t]", bug, null);
        expect(console.error).toHaveBeenCalledWith("[t]", bug);
        expect(reportError).not.toHaveBeenCalled();
    });
});

describe("generateAssistantChatTitle", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("normalizes and returns the generated title", async () => {
        completeText.mockResolvedValue('  "German Liquidity Review."  ');

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Review the company liquidity position",
                apiKeys: {},
            }),
        ).resolves.toBe("German Liquidity Review");
        expect(completeText).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "title-model",
                maxTokens: 64,
                apiKeys: {},
            }),
        );
    });

    it("uses the fallback for an empty model response", async () => {
        completeText.mockResolvedValue("   ");

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Hello",
            }),
        ).resolves.toBe("Misc. Query");
    });

    it("limits generated titles to 80 characters", async () => {
        completeText.mockResolvedValue("x".repeat(100));

        await expect(
            generateAssistantChatTitle({
                model: "title-model",
                message: "Hello",
            }),
        ).resolves.toBe("x".repeat(80));
    });
});
