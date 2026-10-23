import { afterEach, describe, expect, it } from "vitest";
import { buildTabularMessages } from "../tabular.chats";

const store = { documents: [], columns: [] } as never;

function systemText(): string {
    const [first] = buildTabularMessages([], store, "Review") as Array<{ role: string; content: string }>;
    expect(first.role).toBe("system");
    return first.content;
}

afterEach(() => {
    delete process.env.APP_NAME;
    delete process.env.APP_DOMAIN;
});

describe("tabular review chat prompt identity", () => {
    it("keeps Mike's sentences when the environment is unset", () => {
        const text = systemText();
        expect(text.startsWith('You are Mike, an AI legal assistant. You are helping with the tabular review titled "Review".')).toBe(true);
        expect(text).toContain("The review extracts specific fields from multiple legal documents into a structured table.");
    });

    it("takes the name and domain from the environment", () => {
        process.env.APP_NAME = "Acme Assist";
        process.env.APP_DOMAIN = "tax";
        const text = systemText();
        expect(text.startsWith('You are Acme Assist, an AI tax assistant. You are helping with the tabular review titled "Review".')).toBe(true);
        expect(text).toContain("The review extracts specific fields from multiple tax documents into a structured table.");
    });
});
