import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "./providers";

function streamResponse(delta: Record<string, unknown>, finish: string) {
  const chunks = [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function completionResponse() {
  return Response.json({
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "Review title" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
}

describe("direct Mistral adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("streams reasoning, executes tools, and sends the result back to Mistral", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "environment-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse(
          {
            tool_calls: [
              {
                index: 0,
                id: "abc123xyz",
                function: {
                  name: "read_document",
                  arguments: '{"id":"doc-1"}',
                },
              },
            ],
          },
          "tool_calls",
        ),
      )
      .mockResolvedValueOnce(
        streamResponse(
          {
            content: [
              {
                type: "thinking",
                thinking: [{ type: "text", text: "Checking the clause." }],
              },
              { type: "text", text: "The notice period is 30 days." },
            ],
          },
          "stop",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const runTools = vi.fn(async () => [
      { tool_use_id: "abc123xyz", content: "30 days" },
    ]);
    const onContentDelta = vi.fn();
    const onReasoningDelta = vi.fn();

    const result = await streamWithProvider({
      model: "mistral-medium-3-5",
      systemPrompt: "Review the document.",
      messages: [{ role: "user", content: "What is the notice period?" }],
      apiKeys: { mistral: " personal-key " },
      reasoning: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "read_document",
            description: "Read a document",
            parameters: {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
          },
        },
      ],
      runTools,
      callbacks: { onContentDelta, onReasoningDelta },
    });

    expect(result.fullText).toBe("The notice period is 30 days.");
    expect(onContentDelta).toHaveBeenCalledWith(result.fullText);
    expect(onReasoningDelta).toHaveBeenCalledWith("Checking the clause.");
    expect(runTools).toHaveBeenCalledWith([
      { id: "abc123xyz", name: "read_document", input: { id: "doc-1" } },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer personal-key",
      );
      expect(JSON.parse(init.body)).toMatchObject({
        model: "mistral-medium-3-5",
        stream: true,
        reasoning_effort: "high",
      });
    }
    const followup = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(followup.messages).toContainEqual(
      expect.objectContaining({
        role: "tool",
        tool_call_id: "abc123xyz",
        content: "30 days",
      }),
    );
  });

  it("uses the environment key for lightweight completions with reasoning disabled", async () => {
    vi.stubEnv("MISTRAL_API_KEY", " environment-key ");
    const fetchMock = vi.fn().mockResolvedValue(completionResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeWithProvider({
        model: "mistral-small-2603",
        user: "Generate a title",
      }),
    ).resolves.toBe("Review title");
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer environment-key",
    );
    expect(JSON.parse(init.body)).toMatchObject({
      model: "mistral-small-2603",
      reasoning_effort: "none",
      max_tokens: 512,
    });
  });

  it("rejects a missing key without falling through to Ollama", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      completeWithProvider({ model: "mistral-small-2603", user: "Title" }),
    ).rejects.toThrow("MISTRAL_API_KEY");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns rejected Mistral credentials into the existing safe key error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: "Unauthorized" }, { status: 401 }),
        ),
    );
    await expect(
      streamWithProvider({
        model: "mistral-large-4",
        systemPrompt: "Help",
        messages: [{ role: "user", content: "Hi" }],
        apiKeys: { mistral: "invalid-key" },
      }),
    ).rejects.toThrow("The Mistral API key was rejected");
  });
});
