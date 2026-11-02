import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { guardedFetch, vertexAuthClient } = vi.hoisted(() => ({
  guardedFetch: vi.fn(),
  vertexAuthClient: vi.fn(),
}));

// The token exchange is covered in vertexAuth.test.ts; here the adapter only
// needs a client that hands out a token.
vi.mock("./vertexAuth", () => ({ vertexAuthClient }));
vi.mock("../mcp/client", () => ({ guardedFetch }));

import { completeWithProvider } from "./providers";
import { UserFacingError } from "../userFacingError";

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "legal-prod",
  private_key_id: "key-1",
  private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
  client_email: "mike@legal-prod.iam.gserviceaccount.com",
  token_uri: "https://attacker.example/token",
});

function chatCompletionResponse() {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "test-model",
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

function anthropicMessageResponse() {
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Review title" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  });
}

function geminiResponse() {
  return Response.json({
    candidates: [
      {
        content: { role: "model", parts: [{ text: "Review title" }] },
        finishReason: "STOP",
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 2,
      totalTokenCount: 7,
    },
  });
}

function responsesResponse() {
  return Response.json({
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "grok-4.3",
    output: [
      {
        type: "message",
        id: "msg_1",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Review title", annotations: [] }],
      },
    ],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  });
}

function requestOf(fetchMock: ReturnType<typeof vi.fn>) {
  const [input, init] = fetchMock.mock.calls[0] as [
    RequestInfo | URL,
    RequestInit | undefined,
  ];
  return {
    url: String(input instanceof Request ? input.url : input),
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vertexAuthClient.mockResolvedValue({
    getAccessToken: async () => ({ token: "ya29.test" }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Google Vertex AI adapter", () => {
  const apiKeys = {
    vertex: SERVICE_ACCOUNT,
    providerSettings: { vertex: { location: "us-central1" } },
  };

  it("calls Gemini in the key's project and location with a service-account token", async () => {
    // Neither express mode nor ambient credentials may replace the user's key.
    vi.stubEnv("GOOGLE_VERTEX_API_KEY", "express-env-key");
    vi.stubEnv("GOOGLE_VERTEX_PROJECT", "operator-project");
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "vertex/gemini-3.1-pro-preview",
        user: "Name this review",
        apiKeys,
      }),
    ).resolves.toBe("Review title");

    const { url, headers } = requestOf(fetchMock);
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/legal-prod/locations/us-central1/publishers/google/models/gemini-3.1-pro-preview:generateContent",
    );
    expect(headers.get("authorization")).toBe("Bearer ya29.test");
    expect(headers.get("x-goog-api-key")).toBeNull();
    // Only the parsed fields reach the auth client, never the file's token_uri.
    expect(vertexAuthClient).toHaveBeenCalledWith(
      expect.objectContaining({
        clientEmail: "mike@legal-prod.iam.gserviceaccount.com",
        project: "legal-prod",
        privateKeyId: "key-1",
      }),
    );
    expect(vertexAuthClient.mock.calls[0]?.[0]).not.toHaveProperty("token_uri");
  });

  it("calls Claude over Anthropic Messages with the pinned version id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessageResponse());
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "vertex/claude-opus-5-5@20260101",
      user: "x",
      apiKeys,
    });

    const { url, headers } = requestOf(fetchMock);
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/legal-prod/locations/us-central1/publishers/anthropic/models/claude-opus-5-5@20260101:rawPredict",
    );
    expect(headers.get("authorization")).toBe("Bearer ya29.test");
  });

  it("calls publisher/model ids over the partner-model endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "vertex/meta/llama-4-maverick-maas",
      user: "x",
      apiKeys,
    });

    const { url, headers, body } = requestOf(fetchMock);
    expect(url).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/legal-prod/locations/us-central1/endpoints/openapi/chat/completions",
    );
    expect(headers.get("authorization")).toBe("Bearer ya29.test");
    expect(body.model).toBe("meta/llama-4-maverick-maas");
  });

  // PR #608 regression: @ai-sdk/google-vertex interpolates the model id into
  // the request URL unencoded, so a traversal id would carry the service
  // account's bearer token to an arbitrary aiplatform resource.
  it("refuses path-traversal model ids before any request is made", async () => {
    vi.stubEnv("GOOGLE_VERTEX_CREDENTIALS_JSON", SERVICE_ACCOUNT);
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "us-central1");
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessageResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model:
          "vertex/claude/../../../../v1/projects/victim/locations/us-central1/endpoints/123:rawPredict?x=",
        user: "x",
      }),
    ).rejects.toThrow(/not a valid Google Vertex AI model id/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vertexAuthClient).not.toHaveBeenCalled();
  });

  it("does not pair a user key with the environment's location", async () => {
    vi.stubEnv("GOOGLE_VERTEX_CREDENTIALS_JSON", SERVICE_ACCOUNT);
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "europe-west4");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "vertex/gemini-3.1-pro-preview",
        user: "x",
        apiKeys: { vertex: SERVICE_ACCOUNT },
      }),
    ).rejects.toThrow(/Google Vertex AI credentials are not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the deployment's key and location when the user has none", async () => {
    vi.stubEnv("GOOGLE_VERTEX_CREDENTIALS_JSON", SERVICE_ACCOUNT);
    vi.stubEnv("GOOGLE_VERTEX_LOCATION", "global");
    const fetchMock = vi.fn().mockResolvedValue(geminiResponse());
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({ model: "vertex/gemini-3.8-flash", user: "x" });

    expect(requestOf(fetchMock).url).toContain(
      "https://aiplatform.googleapis.com/v1beta1/projects/legal-prod/locations/global/",
    );
  });
});

describe("Azure AI Foundry adapter", () => {
  const apiKeys = {
    "azure-foundry": "foundry-key",
    providerSettings: {
      "azure-foundry": { endpoint: "https://contoso.services.ai.azure.com" },
    },
  };

  it("calls a non-Claude deployment over Chat Completions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(chatCompletionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "azure-foundry/mistral-large-4",
        user: "Name this review",
        apiKeys,
      }),
    ).resolves.toBe("Review title");

    const { url, headers, body } = requestOf(fetchMock);
    expect(url).toBe(
      "https://contoso.services.ai.azure.com/openai/v1/chat/completions",
    );
    expect(headers.get("authorization")).toBe("Bearer foundry-key");
    expect(headers.get("api-key")).toBe("foundry-key");
    expect(body.model).toBe("mistral-large-4");
  });

  it("calls a Claude deployment over Anthropic Messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessageResponse());
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "azure-foundry/claude-opus-5-5",
      user: "x",
      apiKeys,
    });

    const { url, headers, body } = requestOf(fetchMock);
    expect(url).toBe(
      "https://contoso.services.ai.azure.com/anthropic/v1/messages",
    );
    expect(headers.get("x-api-key")).toBe("foundry-key");
    expect(body.model).toBe("claude-opus-5-5");
  });

  it("is unusable without an endpoint", async () => {
    vi.stubEnv("AZURE_FOUNDRY_API_KEY", "env-key");
    vi.stubEnv("AZURE_FOUNDRY_ENDPOINT", "operator-foundry");
    await expect(
      completeWithProvider({
        model: "azure-foundry/mistral-large-4",
        user: "x",
        apiKeys: { "azure-foundry": "foundry-key" },
      }),
    ).rejects.toThrow(/Azure AI Foundry API key is not configured/);
  });
});

describe("xAI adapter", () => {
  it("calls the xAI API with the user's key and the bare model id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(responsesResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "xai/grok-4.3",
        user: "Name this review",
        apiKeys: { xai: "xai-user-key" },
      }),
    ).resolves.toBe("Review title");

    const { url, headers, body } = requestOf(fetchMock);
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(headers.get("authorization")).toBe("Bearer xai-user-key");
    expect(body.model).toBe("grok-4.3");
  });

  it("reports a missing key", async () => {
    vi.stubEnv("XAI_API_KEY", "");
    await expect(
      completeWithProvider({ model: "xai/grok-4.3", user: "x" }),
    ).rejects.toThrow(/xAI API key is not configured/);
  });
});

describe("custom OpenAI-compatible endpoint adapter", () => {
  // PR #608 regression: a guard rejection (the base URL resolves to a
  // private/metadata address) reached the chat as a raw internal error
  // mentioning "MCP server URL"; it is the user's configuration to fix.
  it("turns a blocked destination into a user-facing configuration error", async () => {
    const blocked = Object.assign(
      new Error("Model endpoint URL resolves to a blocked network address."),
      { code: "ERR_BLOCKED_DESTINATION" },
    );
    // undici reports a connect-time lookup failure as "fetch failed" with
    // the guard's error as the cause.
    guardedFetch.mockRejectedValue(new TypeError("fetch failed", { cause: blocked }));

    const error = await completeWithProvider({
      model: "custom/deepseek/deepseek-v4",
      user: "Name this review",
      apiKeys: {
        custom: "sk-custom",
        providerSettings: { custom: { baseUrl: "https://rebind.example.com/v1" } },
      },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(UserFacingError);
    expect((error as Error).message).toMatch(/public address/);
    expect((error as Error).message).not.toMatch(/MCP/);
  });

  it("sends requests through the guarded fetch, never the plain one", async () => {
    guardedFetch.mockResolvedValue(chatCompletionResponse());
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "custom/deepseek/deepseek-v4",
        user: "Name this review",
        apiKeys: {
          custom: "sk-custom",
          providerSettings: {
            custom: { baseUrl: "https://llm.example.com/v1" },
          },
        },
      }),
    ).resolves.toBe("Review title");

    expect(fetchMock).not.toHaveBeenCalled();
    const { url, headers, body } = requestOf(guardedFetch);
    expect(url).toBe("https://llm.example.com/v1/chat/completions");
    expect(headers.get("authorization")).toBe("Bearer sk-custom");
    expect(body.model).toBe("deepseek/deepseek-v4");
  });

  it.each([
    "http://llm.example.com/v1",
    "https://127.0.0.1/v1",
    "https://169.254.169.254/latest",
    "https://metadata.google.internal/v1",
  ])("refuses a saved base URL of %s", async (baseUrl) => {
    await expect(
      completeWithProvider({
        model: "custom/any",
        user: "x",
        apiKeys: { custom: "sk-custom", providerSettings: { custom: { baseUrl } } },
      }),
    ).rejects.toThrow(/OpenAI-compatible endpoint is not configured/);
    expect(guardedFetch).not.toHaveBeenCalled();
  });
});
