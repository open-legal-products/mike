import { describe, expect, it } from "vitest";
import { withPrefixCacheHints } from "../aiSdk";

const messages = [
  { role: "user" as const, content: "memory" },
  { role: "assistant" as const, content: "ok" },
  { role: "user" as const, content: "question" },
];

describe("withPrefixCacheHints", () => {
  it("sends no cache hints for one-shot calls", () => {
    const hints = withPrefixCacheHints({
      model: "gpt-5",
      systemPrompt: "s",
      messages,
    });
    expect(hints.providerOptions).toBeUndefined();
    expect(hints.messages).toBe(messages);
  });

  it("keys the OpenAI cache by conversation and marks an Anthropic breakpoint on the last turn", () => {
    const hints = withPrefixCacheHints({
      model: "gpt-5",
      systemPrompt: "s",
      messages,
      conversationId: "chat-1",
    });
    expect(hints.providerOptions).toEqual({
      openai: { promptCacheKey: "chat-1" },
    });
    // Only the final message carries the breakpoint: Anthropic caches
    // everything before it, and an earlier breakpoint would be wasted.
    expect(hints.messages.slice(0, -1).every((m) => !m.providerOptions)).toBe(
      true,
    );
    expect(hints.messages.at(-1)).toEqual({
      role: "user",
      content: "question",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});
