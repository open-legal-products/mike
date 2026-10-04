import { afterEach, describe, expect, it, vi } from "vitest";
import {
  completeWithProvider,
  fallbackReasoningLevelFromProviderError,
} from "../llm/providers";

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

// A deployment can point the built-in OpenAI models at an OpenAI-protocol
// gateway (an Azure OpenAI v1 endpoint, a LiteLLM proxy) with OPENAI_BASE_URL
// alone (documented in backend/.env.example). The capture point is aiSdkFetch,
// the fetch implementation every provider adapter hands to its SDK, so these
// assertions cover the full request path, including the SDK's own URL join.
describe("OPENAI_BASE_URL gateway routing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mocks.aiSdkFetch.mockReset();
  });

  async function completeThroughCapturedFetch(apiKeys?: { openai?: string }) {
    mocks.aiSdkFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify(responsesApiPayload("routed hello")), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const text = await completeWithProvider({
      model: "gpt-5.4",
      user: "hello",
      apiKeys,
    });
    const [url, init] = mocks.aiSdkFetch.mock.calls.at(-1) ?? [];
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    return {
      text,
      url: String(url),
      authorization: headers.get("authorization"),
    };
  }

  it("sends OpenAI-model requests to api.openai.com when the variable is unset", async () => {
    vi.stubEnv("OPENAI_BASE_URL", undefined);
    const { url } = await completeThroughCapturedFetch();
    expect(url).toBe("https://api.openai.com/v1/responses");
  });

  // backend/.env.example ships the line as `OPENAI_BASE_URL=`, so a copied
  // .env loads it as an empty string. The SDK rejects an empty baseURL
  // ("baseURL must be a non-empty string"), which would break every OpenAI
  // model on a default install.
  it.each(["", "   "])(
    "treats a blank OPENAI_BASE_URL (%j) as unset",
    async (blank) => {
      vi.stubEnv("OPENAI_BASE_URL", blank);
      const { url, text } = await completeThroughCapturedFetch();
      expect(url).toBe("https://api.openai.com/v1/responses");
      expect(text).toBe("routed hello");
    },
  );

  it("routes OpenAI-model requests through OPENAI_BASE_URL when set", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://gateway.test/v1");
    const { text, url } = await completeThroughCapturedFetch();
    expect(url).toBe("http://gateway.test/v1/responses");
    expect(text).toBe("routed hello");
  });

  it("drops a trailing slash and surrounding whitespace from the gateway URL", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "  https://res.openai.azure.com/openai/v1/  ");
    const { url } = await completeThroughCapturedFetch();
    expect(url).toBe("https://res.openai.azure.com/openai/v1/responses");
  });

  // Tradeoff pinned on purpose: a user's saved OpenAI key travels to the
  // configured gateway, exactly as it would to api.openai.com.
  it("sends the requesting user's saved OpenAI key to the gateway", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "http://gateway.test/v1");
    const { url, authorization } = await completeThroughCapturedFetch({
      openai: "user-key",
    });
    expect(url).toBe("http://gateway.test/v1/responses");
    expect(authorization).toBe("Bearer user-key");
  });
});
