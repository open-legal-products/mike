import { describe, expect, it, vi } from "vitest";

type StreamParams = {
  runTools: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<unknown>;
};
const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools:
    vi.fn<(...args: [StreamParams]) => Promise<{ fullText: string }>>(),
}));
vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>(
    "../../../../lib/llm/models",
  )),
  streamChatWithTools,
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

import { isAbortError, runLLMStream } from "../streaming";
import { runToolCalls } from "../tools/toolDispatcher";

const cardCall = (id: string) => ({
  id,
  name: "create_text_card",
  input: { title: `Card ${id}`, text: "Body" },
});

const cardFrames = (write: ReturnType<typeof vi.fn>) =>
  write.mock.calls
    .map(([frame]) => String(frame))
    .filter((frame) => frame.includes('"type":"text_card"'));

describe("a stopped turn's tool batch", () => {
  it("starts no further tools once the turn's signal has fired", async () => {
    const controller = new AbortController();
    // The first tool's output is the moment a deadline or Stop lands.
    const write = vi.fn((frame: string) => {
      if (frame.includes('"type":"text_card"')) controller.abort();
    });

    const result = await runToolCalls(
      ["a", "b", "c"].map((id) => ({
        id,
        function: {
          name: "create_text_card",
          arguments: JSON.stringify(cardCall(id).input),
        },
      })),
      new Map(),
      "user-1",
      {} as never,
      write,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { signal: controller.signal },
    );

    expect(cardFrames(write)).toHaveLength(1);
    expect(result.textCardEvents.map((event) => event.card_id)).toEqual(["a"]);
  });

  it("is wired to the answer's signal, so the stream ends as stopped", async () => {
    const controller = new AbortController();
    const write = vi.fn((frame: string) => {
      if (frame.includes('"type":"text_card"')) controller.abort();
    });
    streamChatWithTools.mockImplementationOnce(async ({ runTools }) => {
      await runTools([cardCall("a"), cardCall("b")]);
      return { fullText: "" };
    });

    const outcome = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Draft two cards." }],
      docStore: new Map(),
      docIndex: {},
      userId: "user-1",
      db: {} as never,
      write,
      includeAskInputs: false,
      allowDocumentMutation: false,
      signal: controller.signal,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(isAbortError(outcome)).toBe(true);
    expect(cardFrames(write)).toHaveLength(1);
  });
});
