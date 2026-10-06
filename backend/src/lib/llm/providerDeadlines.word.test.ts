import { afterEach, expect, it, vi } from "vitest";
import { streamAiSdk } from "./aiSdk";
import {
  callStep,
  config,
  makeModel,
  textStep,
  TOOLS,
} from "./__tests__/mockLanguageModel";
import {
  CLIENT_TOOL_TIMEOUT_RESULT,
  waitForClientToolResult,
} from "../../modules/chat/engine/tools/wordClientTools";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("the locked OpenAI adapter requests reasoning summaries for high effort", async () => {
  const { createOpenAI } = await import("@ai-sdk/openai");
  let body: Record<string, unknown> | undefined;
  const openai = createOpenAI({
    apiKey: "synthetic-test-key",
    fetch: async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          error: {
            message: "Synthetic stop after inspecting request",
            type: "invalid_request_error",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
  });
  await streamAiSdk(
    {
      model: "gpt-5",
      systemPrompt: "S",
      messages: [{ role: "user", content: "test" }],
      reasoning: "high",
    },
    {
      provider: "openai",
      label: "OpenAI",
      model: openai.responses("gpt-5") as never,
      modelId: "gpt-5",
    },
  ).catch(() => {});
  expect(body?.reasoning).toEqual({ effort: "high", summary: "detailed" });
});

it.each([30000, 60000, 61000])(
  "Word bridge timeout at %i ms can return its normal tool result",
  async (toolMs) => {
    const model = await makeModel([
      callStep("bridge", "read_document", { doc_id: "doc" }),
      textStep("recovered"),
    ]);
    vi.useFakeTimers();
    vi.stubEnv("STREAM_CHUNK_TIMEOUT_MS", "60000");
    let start!: () => void;
    const started = new Promise<void>((r) => {
      start = r;
    });
    let bridgeResult: unknown;
    const pending = streamAiSdk(
      {
        model: "m",
        systemPrompt: "S",
        messages: [{ role: "user", content: "test" }],
        tools: TOOLS,
        runTools: async (calls) => {
          const waited = waitForClientToolResult({
            callId: "bridge-" + toolMs,
            userId: "u",
            timeoutMs: toolMs,
          });
          start();
          bridgeResult = await waited;
          return calls.map((call) => ({
            tool_use_id: call.id,
            content: JSON.stringify(bridgeResult),
          }));
        },
      },
      config(model),
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await started;
    await vi.advanceTimersByTimeAsync(62000);
    const result = await pending;
    expect(bridgeResult).toBe(CLIENT_TOOL_TIMEOUT_RESULT);
    expect(result).toEqual({ value: { fullText: "recovered" } });
  },
);
