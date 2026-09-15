import { beforeEach, describe, expect, it, vi } from "vitest";

const { completeText } = vi.hoisted(() => ({
    completeText: vi.fn(),
}));

vi.mock("../../../lib/llm", () => ({ completeText }));

import { generateAssistantChatTitle } from "../chat.title";

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
