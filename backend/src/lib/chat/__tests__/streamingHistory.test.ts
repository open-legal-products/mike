import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async () => ({ fullText: "" })),
}));

vi.mock("../../llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../llm/models")),
  streamChatWithTools: (...args: unknown[]) => streamChatWithTools(...args),
}));
vi.mock("../../mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: vi.fn(),
}));

import { runLLMStream } from "../streaming";

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
});

describe("runLLMStream history", () => {
  it("drops assistant turns that carry no text so no provider sees an empty block", async () => {
    // A cancelled or errored turn, or a client that keeps prose in events,
    // replays as content "". Anthropic rejects the whole request over one
    // such block ("text content blocks must be non-empty").
    await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "first" },
        { role: "assistant", content: "" },
        { role: "user", content: "second" },
        { role: "assistant", content: "kept" },
        { role: "user", content: "third" },
      ],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: vi.fn(),
    });
    const params = streamChatWithTools.mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    expect(params.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["user", "second"],
      ["assistant", "kept"],
      ["user", "third"],
    ]);
  });
});
