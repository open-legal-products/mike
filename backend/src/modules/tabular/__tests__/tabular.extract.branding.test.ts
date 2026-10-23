import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ systemPrompts: [] as string[] }));
vi.mock("../../../lib/llm", () => ({
    completeText: vi.fn(async (args: { systemPrompt: string }) => {
        calls.systemPrompts.push(args.systemPrompt);
        return '{"summary":"x","flag":"grey","reasoning":"y"}';
    }),
    streamChatWithTools: vi.fn(async (args: { systemPrompt: string }) => {
        calls.systemPrompts.push(args.systemPrompt);
    }),
}));

import { queryTabularAllColumns, queryTabularCell } from "../tabular.extract";

const column = { index: 0, name: "Parties", prompt: "Name the parties", format: "text" };

async function systemPrompts(): Promise<string[]> {
    await queryTabularCell("m", "a.pdf", "text", "Name the parties", "text");
    await queryTabularAllColumns("m", "a.pdf", "text", [column] as never, async () => {});
    return calls.systemPrompts;
}

beforeEach(() => {
    calls.systemPrompts = [];
});
afterEach(() => {
    delete process.env.APP_DOMAIN;
});

describe("tabular extraction prompts", () => {
    it("name the legal domain by default", async () => {
        const prompts = await systemPrompts();
        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
            expect(prompt.startsWith("You are a legal document analyst.")).toBe(true);
        }
    });

    it("name the domain from APP_DOMAIN", async () => {
        process.env.APP_DOMAIN = "tax";
        const prompts = await systemPrompts();
        expect(prompts).toHaveLength(2);
        for (const prompt of prompts) {
            expect(prompt.startsWith("You are a tax document analyst.")).toBe(true);
        }
    });
});
