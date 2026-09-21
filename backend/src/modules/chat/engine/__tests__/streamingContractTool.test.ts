import { beforeEach, describe, expect, it, vi } from "vitest";

// review_contract runs on OpenRouter through the contracts module. A deployment
// without that key cannot run it, so the model must not be shown the schema.

const { streamChatWithTools, openRouterConfigured } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  openRouterConfigured: vi.fn(() => false),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../../../../lib/openRouterChat", () => ({ openRouterConfigured: () => openRouterConfigured() }));

import { runLLMStream } from "../streaming";

type StreamChatCall = {
  tools: { function: { name: string } }[];
  [key: string]: unknown;
};

function baseParams() {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "hi" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
  };
}

function advertisedToolNames(): string[] {
  const params = streamChatWithTools.mock.calls[0]?.[0] as StreamChatCall;
  return params.tools.map((tool) => tool.function.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("review_contract advertisement", () => {
  it("is offered when OpenRouter is configured", async () => {
    openRouterConfigured.mockReturnValue(true);
    await runLLMStream(baseParams());
    expect(advertisedToolNames()).toContain("review_contract");
  });

  it("is hidden when OpenRouter is not configured", async () => {
    openRouterConfigured.mockReturnValue(false);
    await runLLMStream(baseParams());
    expect(advertisedToolNames()).not.toContain("review_contract");
  });
});
