import { beforeEach, describe, expect, it, vi } from "vitest";

// Declaring the stub's parameter (rather than a zero-arity `vi.fn`) is what
// lets tsc check the `mock.calls[0][0]` lookup below; with an empty call tuple
// every assertion on it type-checks vacuously.
type StreamChatCall = {
  systemPrompt: string;
  messages: { role: string; content: string; reasoning?: string }[];
  [key: string]: unknown;
};

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
    fullText: "",
  })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
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
    const params = streamChatWithTools.mock.calls[0]![0];
    expect(params.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "first"],
      ["user", "second"],
      ["assistant", "kept"],
      ["user", "third"],
    ]);
  });

  it("carries attached reasoning on assistant turns through to the model call", async () => {
    await runLLMStream({
      model: "gemini-3-flash-preview",
      apiMessages: [
        { role: "system", content: "SYSTEM" },
        { role: "user", content: "first" },
        { role: "assistant", content: "answer", reasoning: "why" },
        { role: "user", content: "second" },
      ],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: vi.fn(),
    });
    const params = streamChatWithTools.mock.calls[0]![0];
    expect(params.messages).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer", reasoning: "why" },
      { role: "user", content: "second" },
    ]);
  });
});

type ReasoningCallbacks = {
  onReasoningDelta: (delta: string) => void;
  onReasoningBlockEnd: () => void;
  onContentDelta: (delta: string) => void;
};

const streamArgs = () => ({
  model: "gemini-3-flash-preview",
  apiMessages: [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "question" },
  ],
  docStore: new Map(),
  docIndex: {},
  userId: "u1",
  db: {} as never,
  write: vi.fn(),
});

describe("runLLMStream reasoning provenance", () => {
  it("stamps stored reasoning with the model that produced it", async () => {
    streamChatWithTools.mockImplementationOnce(async (params) => {
      const callbacks = params.callbacks as ReasoningCallbacks;
      callbacks.onReasoningDelta("Thinking.");
      callbacks.onReasoningBlockEnd();
      callbacks.onContentDelta("Answer.");
      return { fullText: "Answer." };
    });

    const { events } = await runLLMStream(streamArgs());

    expect(events).toContainEqual({
      type: "reasoning",
      text: "Thinking.",
      model: "gemini-3-flash-preview",
    });
  });

  it("stamps reasoning flushed from a turn that failed mid-thought", async () => {
    streamChatWithTools.mockImplementationOnce(async (params) => {
      (params.callbacks as ReasoningCallbacks).onReasoningDelta("Half a thought");
      throw new Error("upstream dropped");
    });

    const failure = await runLLMStream(streamArgs()).catch((e: unknown) => e);

    expect((failure as { events?: unknown[] }).events).toContainEqual({
      type: "reasoning",
      text: "Half a thought",
      model: "gemini-3-flash-preview",
    });
  });
});
