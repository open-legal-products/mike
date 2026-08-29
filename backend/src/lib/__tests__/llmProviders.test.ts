import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackReasoningLevelFromProviderError } from "../llm/providers";

// A minimal OpenAI Responses-API payload, enough for generateText to parse.
function responsesApiPayload(text: string) {
  return {
    id: "resp_test_1",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: "gpt-5.4",
    output: [
      {
        type: "message",
        id: "msg_test_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: null,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: null,
    truncation: "disabled",
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 9,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 19,
    },
    user: null,
    metadata: {},
  };
}

const mocks = vi.hoisted(() => ({
  aiSdkFetch: vi.fn(),
}));

vi.mock("../llm/aiSdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../llm/aiSdk")>()),
  aiSdkFetch: mocks.aiSdkFetch,
}));

describe("fallbackReasoningLevelFromProviderError", () => {
  it("selects the nearest level advertised by a provider", () => {
    const error = new Error(
      "Unsupported value: 'low' is not supported with the model. Supported values are: 'none', 'medium', 'high', and 'xhigh'.",
    );

    expect(fallbackReasoningLevelFromProviderError(error, "low")).toBe(
      "medium",
    );
  });

  it("does not retry unrelated provider failures", () => {
    expect(
      fallbackReasoningLevelFromProviderError(
        new Error("The provider is unavailable"),
        "high",
      ),
    ).toBeUndefined();
  });
});

// Mike relies on @ai-sdk/openai reading OPENAI_BASE_URL when no explicit
// baseURL is configured — that is what lets a deployment point OpenAI models
// at an Azure OpenAI v1 endpoint or a LiteLLM proxy with configuration alone
// (documented in backend/.env.example). The SDK's env fallback is not part of
// Mike's own code, so these tests pin it against SDK upgrades. The capture
// point is aiSdkFetch, the fetch implementation every provider adapter hands
// to its SDK, so the assertion covers the full request path.
describe("OPENAI_BASE_URL gateway routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.aiSdkFetch.mockReset();
  });

  async function completeThroughCapturedFetch() {
    mocks.aiSdkFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify(responsesApiPayload("routed hello")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const { completeWithProvider } = await import("../llm/providers");
    const text = await completeWithProvider({
      model: "gpt-5.4",
      user: "hello",
    });
    return { text, url: String(mocks.aiSdkFetch.mock.calls.at(-1)?.[0]) };
  }

  it("sends OpenAI-model requests to api.openai.com by default", async () => {
    const { url } = await completeThroughCapturedFetch();
    expect(url).toBe("https://api.openai.com/v1/responses");
  });

  it("routes OpenAI-model requests through OPENAI_BASE_URL when set", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://gateway.test/v1");
    const { text, url } = await completeThroughCapturedFetch();
    expect(url).toBe("http://gateway.test/v1/responses");
    expect(text).toBe("routed hello");
  });
});
