import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

import { aiSdkFetch, streamAiSdk } from "./aiSdk";

function streamResponse(chunks: unknown[]): Response {
  const body = `${chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function functionTool(name: string) {
  return {
    type: "function" as const,
    function: {
      name,
      description: `${name} test tool`,
      parameters: { type: "object" },
    },
  };
}

describe("aiSdkFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards clean malformed tool arguments and the final usage frame unchanged", async () => {
    const malformedArguments =
      '{"title":"Example Report","sections":';
    const body = [
      `data: ${JSON.stringify({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call-docx",
                  type: "function",
                  function: {
                    name: "generate_docx",
                    arguments: malformedArguments,
                  },
                },
              ],
            },
          },
        ],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: {}, finish_reason: "tool_calls" }],
        usage: {
          prompt_tokens: 17,
          completion_tokens: 9,
          total_tokens: 26,
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    );

    const response = await aiSdkFetch(
      "https://example.test/v1/chat/completions",
    );

    // aiSdkFetch only appends the delimiter needed to flush a proxy-closed
    // final event; the provider's bytes, including malformed arguments and
    // final usage, are otherwise untouched.
    await expect(response.text()).resolves.toBe(`${body}\n\n`);
  });

  it("lets the OpenAI-compatible SDK recover a clean malformed generate_docx call", async () => {
    // The OpenAI-compatible parser forwards malformed input to Core 7, which
    // emits a dynamic tool-error rather than calling Mike's tool executor.
    const malformedArguments =
      '{"title":"Example Report","sections":';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        streamResponse([
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-docx",
                      type: "function",
                      function: {
                        name: "generate_docx",
                        arguments: malformedArguments,
                      },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
            usage: {
              prompt_tokens: 17,
              completion_tokens: 9,
              total_tokens: 26,
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        streamResponse([
          { choices: [{ delta: { content: "Recovered" } }] },
          {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 24,
              completion_tokens: 1,
              total_tokens: 25,
            },
          },
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);
    const openAICompatible = createOpenAICompatible({
      name: "openai-compatible-test",
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: aiSdkFetch,
    });
    const runTools = vi.fn();

    const result = await streamAiSdk(
      {
        model: "example/model",
        systemPrompt: "Help",
        messages: [{ role: "user", content: "Make the report" }],
        tools: [functionTool("generate_docx")],
        runTools,
      },
      {
        // This local transport test only needs an existing provider
        // discriminant; every response is supplied by the fetch mock above.
        provider: "ollama",
        label: "OpenAI-compatible test",
        model: openAICompatible("example/model"),
        modelId: "example/model",
        supportsReasoning: false,
      },
    );

    expect(result.fullText).toBe("Recovered");
    expect(runTools).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
