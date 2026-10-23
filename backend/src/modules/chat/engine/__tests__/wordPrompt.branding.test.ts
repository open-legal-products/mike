import { afterEach, describe, expect, it } from "vitest";
import { buildWordChatSystemPrompt } from "../wordPrompt";

afterEach(() => {
    delete process.env.APP_NAME;
    delete process.env.APP_DOMAIN;
});

describe("Word chat prompt identity", () => {
    it("keeps Mike's sentence when the environment is unset", () => {
        for (const prompt of [buildWordChatSystemPrompt(false), buildWordChatSystemPrompt(true)]) {
            expect(
                prompt.startsWith("You are Mike, an AI legal assistant running inside Microsoft Word."),
            ).toBe(true);
        }
    });

    it("takes the name and domain from the environment", () => {
        process.env.APP_NAME = "Acme Assist";
        process.env.APP_DOMAIN = "tax";
        for (const prompt of [buildWordChatSystemPrompt(false), buildWordChatSystemPrompt(true)]) {
            expect(
                prompt.startsWith("You are Acme Assist, an AI tax assistant running inside Microsoft Word."),
            ).toBe(true);
        }
    });
});
