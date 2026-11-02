import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatWithTools, runToolCalls, searchWeb } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
    fullText: "",
  })),
  runToolCalls: vi.fn(async (_calls: { function: { name: string } }[]) => ({
    toolResults: [] as { tool_call_id: string; content: string }[],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  })),
  searchWeb: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: (calls: { function: { name: string } }[]) =>
    runToolCalls(calls),
}));

vi.mock("../../../../lib/webSearch", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/webSearch")),
  searchWeb,
}));

import { runLLMStream, sanitizeAssistantSseChunk } from "../streaming";

type StreamChatCall = {
  tools: { function: { name: string } }[];
  runTools?: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<{ tool_use_id: string; content: string }[]>;
  [key: string]: unknown;
};

const BRAVE = "brave" as const;
const PROVIDER = "provider" as const;

function baseParams() {
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user", content: "What changed in the act?" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
  searchWeb.mockReset();
});

describe("runLLMStream web search", () => {
  it.each([
    ["no plan", null, false, false],
    ["the provider's search", PROVIDER, false, true],
    ["Brave Search", BRAVE, true, true],
  ] as const)(
    "with %s, advertises Mike's web_search %s and read_webpage %s",
    async (_, webSearch, search, read) => {
      await runLLMStream({ ...baseParams(), webSearch });

      const names = streamChatWithTools.mock.calls[0]![0].tools.map((t) => t.function.name);
      expect(names.includes("web_search")).toBe(search);
      expect(names.includes("read_webpage")).toBe(read);
    },
  );

  it("answers web calls itself and sends only the rest to the dispatcher", async () => {
    searchWeb.mockResolvedValue([{ url: "https://law.test/act", title: "The Act", snippet: "s" }]);
    let results: { tool_use_id: string; content: string }[] | undefined;
    streamChatWithTools.mockImplementationOnce(async (params) => {
      results = await params.runTools?.([
        { id: "search", name: "web_search", input: { query: "the act" } },
        { id: "doc", name: "read_document", input: { doc_id: "doc-0" } },
      ]);
      return { fullText: "Answer" };
    });

    const result = await runLLMStream({
      ...baseParams(),
      webSearch: "tavily",
      apiKeys: { brave: "brave-key", tavily: "tavily-key" },
    });

    expect(searchWeb).toHaveBeenCalledWith(
      "the act",
      expect.objectContaining({ account: { backend: "tavily", apiKey: "tavily-key" } }),
    );
    expect(runToolCalls.mock.calls[0]![0].map((c) => c.function.name)).toEqual([
      "read_document",
    ]);
    expect(results?.[0]).toMatchObject({ tool_use_id: "search" });
    expect(results?.[0].content).toContain('<untrusted-content nonce="turnnonce">');
    expect(result.events).toContainEqual({
      type: "web_search",
      search_id: "search",
      query: "the act",
      results: [{ url: "https://law.test/act", title: "The Act" }],
    });
  });

  it("rebuilds a web event's error from its code without the raw message", () => {
    const chunk = sanitizeAssistantSseChunk(
      `data: ${JSON.stringify({
        type: "web_search",
        error: "connect ECONNREFUSED 10.0.0.1:443",
        error_code: "rejected",
      })}\n\n`,
    );

    expect(chunk).toContain("the search service refused the request");
    expect(chunk).not.toContain("ECONNREFUSED");
  });
});
