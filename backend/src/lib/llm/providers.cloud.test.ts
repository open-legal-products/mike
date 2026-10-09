import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bedrockModelSupportsCachePoint,
  completeWithProvider,
} from "./providers";

function bedrockConverseResponse() {
  return Response.json({
    output: {
      message: { role: "assistant", content: [{ text: "Review title" }] },
    },
    stopReason: "end_turn",
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
  });
}

function azureResponsesResponse() {
  return Response.json({
    id: "resp_1",
    object: "response",
    created_at: 1_700_000_000,
    status: "completed",
    model: "gpt-6.1-sol",
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
  };
}

describe("Amazon Bedrock adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("calls Converse in the key's region with bearer auth and the bare model id", async () => {
    // Ambient SigV4 credentials (e.g. for S3) must not be used instead.
    vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIA-ambient");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
    const fetchMock = vi.fn().mockResolvedValue(bedrockConverseResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "bedrock/us.anthropic.claude-opus-5-5",
        user: "Name this review",
        apiKeys: {
          bedrock: "user-bedrock-key",
          providerSettings: { bedrock: { region: "eu-west-2" } },
        },
      }),
    ).resolves.toBe("Review title");

    const { url, headers } = requestOf(fetchMock);
    expect(url).toBe(
      "https://bedrock-runtime.eu-west-2.amazonaws.com/model/us.anthropic.claude-opus-5-5/converse",
    );
    expect(headers.get("authorization")).toBe("Bearer user-bedrock-key");
  });

  it("does not pair a user key with the environment's region", async () => {
    vi.stubEnv("BEDROCK_AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "env-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "bedrock/anthropic.claude-sonnet-5-5",
        user: "x",
        apiKeys: { bedrock: "user-key" },
      }),
    ).rejects.toThrow(/Amazon Bedrock API key is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the deployment's key and region when the user has none", async () => {
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "env-key");
    vi.stubEnv("BEDROCK_AWS_REGION", "");
    vi.stubEnv("AWS_REGION", "ap-southeast-2");
    const fetchMock = vi.fn().mockResolvedValue(bedrockConverseResponse());
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "bedrock/amazon.nova-pro-v1:0",
      user: "x",
    });

    const { url, headers } = requestOf(fetchMock);
    expect(url).toContain("bedrock-runtime.ap-southeast-2.amazonaws.com");
    expect(headers.get("authorization")).toBe("Bearer env-key");
  });

  it("adds cache points only for Claude model ids", () => {
    expect(bedrockModelSupportsCachePoint("anthropic.claude-opus-5-5")).toBe(
      true,
    );
    expect(
      bedrockModelSupportsCachePoint("us.anthropic.claude-sonnet-5-5"),
    ).toBe(true);
    expect(
      bedrockModelSupportsCachePoint(
        "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
      ),
    ).toBe(true);
    expect(bedrockModelSupportsCachePoint("meta.llama4-maverick-v1:0")).toBe(
      false,
    );
  });
});

describe("Azure OpenAI adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("calls the resource's v1 Responses API with the deployment name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(azureResponsesResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "azure/gpt-6.1-sol",
        user: "Name this review",
        apiKeys: {
          azure: "user-azure-key",
          providerSettings: { azure: { endpoint: "contoso-openai" } },
        },
      }),
    ).resolves.toBe("Review title");

    const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
    const { url, headers } = requestOf(fetchMock);
    expect(url).toBe(
      "https://contoso-openai.openai.azure.com/openai/v1/responses?api-version=v1",
    );
    expect(headers.get("api-key")).toBe("user-azure-key");
    expect(JSON.parse(String(init.body)).model).toBe("gpt-6.1-sol");
  });

  it("accepts a full endpoint URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(azureResponsesResponse());
    vi.stubGlobal("fetch", fetchMock);

    await completeWithProvider({
      model: "azure/my-deployment",
      user: "x",
      apiKeys: {
        azure: "k",
        providerSettings: {
          azure: { endpoint: "https://contoso.cognitiveservices.azure.com" },
        },
      },
    });

    expect(requestOf(fetchMock).url).toBe(
      "https://contoso.cognitiveservices.azure.com/openai/v1/responses?api-version=v1",
    );
  });

  it("never sends a user's key to the deployment's endpoint", async () => {
    vi.stubEnv("AZURE_API_KEY", "env-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "operator-openai");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      completeWithProvider({
        model: "azure/gpt-6.1-sol",
        user: "x",
        apiKeys: { azure: "user-key" },
      }),
    ).rejects.toThrow(/Azure OpenAI API key is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
