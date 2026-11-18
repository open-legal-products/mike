import { describe, expect, it, vi } from "vitest";
import { withPrefixCacheHints } from "./aiSdk";

describe("Bedrock source prefix serialization", () => {
  it("emits the checkpoint between the source and changing instructions", async () => {
    const { generateText } = await import("ai");
    const { createAmazonBedrock } = await import("@ai-sdk/amazon-bedrock");
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      output: { message: { role: "assistant", content: [{ text: "ok" }] } },
      stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
      metrics: { latencyMs: 1 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const provider = createAmazonBedrock({ region: "us-east-1", apiKey: "test-only", fetch });
    for (const suffix of ["Price", "Party"]) {
      const prefix = "Document source\n";
      const hints = withPrefixCacheHints({ model: "model", systemPrompt: "system",
        messages: [{ role: "user", content: prefix + suffix }], sourcePrefixLength: prefix.length,
      }, { sourceCachePoint: true, bedrockCachePoint: true });
      await generateText({ model: provider("anthropic.claude-sonnet-4-5-20250929-v1:0"), ...hints });
      const call = fetch.mock.calls.at(-1) as unknown as [unknown, RequestInit];
      expect(JSON.parse(String(call[1].body)).messages).toEqual([
        { role: "user", content: [{ text: prefix }, { cachePoint: { type: "default" } }, { text: suffix }] },
      ]);
    }
  });
});
