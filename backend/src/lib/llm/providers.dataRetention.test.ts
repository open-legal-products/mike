import { afterEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "./providers";
import type { UserApiKeys } from "./types";

// Every request a provider receives, as parsed JSON bodies, in order.
function sentBodies(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([, init]) =>
    JSON.parse(String((init as RequestInit).body)),
  ) as Array<Record<string, unknown>>;
}

function sse(events: unknown[], done = false): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    (done ? "data: [DONE]\n\n" : "");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const responsesUsage = { input_tokens: 5, output_tokens: 2 };

function responsesJson(model: string): Response {
  return Response.json({
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Title", annotations: [] }],
      },
    ],
    usage: { ...responsesUsage, total_tokens: 7 },
  });
}

/** Step 1 of a tool turn: the model reasons, then calls read_document. */
function responsesToolCallStream(model: string): Response {
  const reasoning = {
    type: "reasoning",
    id: "rs_1",
    encrypted_content: "ENCRYPTED-REASONING",
    summary: [],
  };
  const call = {
    type: "function_call",
    id: "fc_1",
    call_id: "call_1",
    name: "read_document",
    arguments: '{"doc_id":"d1"}',
  };
  return sse([
    { type: "response.created", response: { id: "resp_1", created_at: 1, model } },
    { type: "response.output_item.added", output_index: 0, item: reasoning },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_item.added", output_index: 1, item: call },
    {
      type: "response.output_item.done",
      output_index: 1,
      item: { ...call, status: "completed" },
    },
    { type: "response.completed", response: { usage: responsesUsage } },
  ]);
}

function responsesTextStream(model: string): Response {
  return sse([
    { type: "response.created", response: { id: "resp_2", created_at: 2, model } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_2" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_2",
      output_index: 0,
      content_index: 0,
      delta: "Done.",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_2" },
    },
    { type: "response.completed", response: { usage: responsesUsage } },
  ]);
}

function chatCompletionsStream(text: string): Response {
  return sse(
    [
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant", content: text } }],
      },
      {
        id: "chat_1",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ],
    true,
  );
}

function chatCompletionsJson(text: string): Response {
  return Response.json({
    id: "chat_1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function gatewayStream(text: string): Response {
  return sse([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    {
      type: "finish",
      finishReason: "stop",
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
    },
  ]);
}

async function streamTurn(model: string, apiKeys: UserApiKeys) {
  return streamWithProvider({
    model,
    systemPrompt: "S",
    messages: [{ role: "user", content: "Summarise the engagement letter." }],
    apiKeys,
    conversationId: "conv-1",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI Responses requests ask OpenAI not to store them", () => {
  it("sends store=false on a one-shot completion", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responsesJson("gpt-6.1-sol"));
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "gpt-6.1-sol",
      user: "Name this chat",
      apiKeys: { openai: "test-key" },
    });

    expect(sentBodies(fetchMock)[0]).toMatchObject({ store: false });
  });

  it("carries the reasoning itself, not a stored reference, into the next tool step", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responsesToolCallStream("gpt-6.1-sol"))
      .mockResolvedValueOnce(responsesTextStream("gpt-6.1-sol"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamWithProvider({
      model: "gpt-6.1-sol",
      systemPrompt: "S",
      messages: [{ role: "user", content: "Summarise d1." }],
      apiKeys: { openai: "test-key" },
      conversationId: "conv-1",
      reasoning: "high",
      tools: [
        {
          type: "function",
          function: {
            name: "read_document",
            description: "Read a document",
            parameters: {
              type: "object",
              properties: { doc_id: { type: "string" } },
            },
          },
        },
      ],
      runTools: async (calls) =>
        calls.map((call) => ({ tool_use_id: call.id, content: "Document text" })),
    });

    expect(result.fullText).toBe("Done.");
    const [first, second] = sentBodies(fetchMock);
    for (const body of [first, second]) {
      expect(body.store).toBe(false);
      // Without stored state the API must hand back the reasoning encrypted.
      expect(body.include).toContain("reasoning.encrypted_content");
      // The existing prompt-cache hint survives the merge.
      expect(body.prompt_cache_key).toBe("conv-1");
    }
    const input = second.input as Array<Record<string, unknown>>;
    // Nothing points at server-side state that store=false never created.
    expect(input.some((item) => item.type === "item_reference")).toBe(false);
    expect(second.previous_response_id).toBeUndefined();
    expect(input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "ENCRYPTED-REASONING",
        }),
        expect.objectContaining({ type: "function_call", call_id: "call_1" }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_1",
        }),
      ]),
    );
  });

  it("sends store=false to Azure OpenAI's Responses API as well", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responsesJson("gpt-6.1-sol"));
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "azure/gpt-6.1-sol",
      user: "x",
      apiKeys: {
        azure: "test-key",
        providerSettings: { azure: { endpoint: "contoso-openai" } },
      },
    });

    expect(sentBodies(fetchMock)[0]).toMatchObject({ store: false });
  });

  it("sends store=false to xAI, whose Responses API also stores by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responsesJson("grok-4.3"));
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "xai/grok-4.3",
      user: "x",
      apiKeys: { xai: "test-key" },
    });

    expect(sentBodies(fetchMock)[0]).toMatchObject({ store: false });
  });
});

describe("router requests exclude upstreams that keep or train on prompts", () => {
  it("asks OpenRouter to deny data collection, keeping the reasoning level", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletionsStream("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await streamTurn("openrouter/openai/gpt-4o", { openrouter: "test-key" });

    const body = sentBodies(fetchMock)[0];
    expect(body.provider).toEqual({ data_collection: "deny" });
    expect(body.reasoning).toEqual({ effort: "none" });
  });

  it("asks OpenRouter to deny data collection on one-shot completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletionsJson("Title"));
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "openrouter/openai/gpt-4o",
      user: "Name this chat",
      apiKeys: { openrouter: "test-key" },
    });

    expect(sentBodies(fetchMock)[0].provider).toEqual({
      data_collection: "deny",
    });
  });

  it("asks the Vercel AI Gateway to skip providers that train on prompts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(gatewayStream("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await streamTurn("vercel/openai/gpt-5", { vercel: "test-key" });

    const options = (
      sentBodies(fetchMock)[0] as {
        providerOptions?: Record<string, Record<string, unknown>>;
      }
    ).providerOptions;
    expect(options?.gateway).toEqual({ disallowPromptTraining: true });
    // OpenAI's store flag belongs to the direct adapter, not the gateway.
    expect(options?.openai).toEqual({ promptCacheKey: "conv-1" });
  });
});

describe("providers without a request-level retention control get no new fields", () => {
  it.each([
    ["Anthropic", "claude-opus-5-5", { claude: "test-key" }],
    ["OpenCode Go", "opencode-go/glm-5", { "opencode-go": "test-key" }],
  ] as const)("%s requests carry no store or provider field", async (_label, model, apiKeys) => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new Error("stop after capturing the request"));
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({ model, user: "x", apiKeys }).catch(() => {});

    const body = sentBodies(fetchMock)[0];
    expect(body).not.toHaveProperty("store");
    expect(body).not.toHaveProperty("provider");
  });
});
