import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider } from "./providers";

describe("current provider model compatibility", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["gpt-6-astra", "low"],
    ["gpt-6.1-sol", "low"],
    ["gpt-6-luna", "none"],
  ])(
    "uses Responses and supported reasoning for %s completions",
    async (model, effort) => {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          id: "resp_test",
          created_at: 1,
          model,
          status: "completed",
          output: [
            {
              type: "message",
              id: "msg_test",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "Title", annotations: [] },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        completeWithProvider({
          model,
          user: "Title",
          apiKeys: { openai: "test-key" },
        }),
      ).resolves.toBe("Title");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(JSON.parse(init.body)).toMatchObject({
        model,
        reasoning: { effort },
      });
    },
  );

  it.each([
    ["claude-fable-5-1", "low"],
    ["claude-opus-5-5", "low"],
    ["claude-sonnet-5-5", "between_tools"],
  ])("keeps %s's lowest thinking mode valid", async (model, mode) => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: "Title" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeWithProvider({
        model,
        user: "Title",
        apiKeys: { claude: "test-key" },
      }),
    ).resolves.toBe("Title");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(init.body);
    expect(body.model).toBe(model);
    expect(body.thinking?.type).not.toBe("disabled");
    if (mode === "between_tools") expect(body.thinking.type).toBe(mode);
    else expect(body.output_config.effort).toBe(mode);
  });
});
