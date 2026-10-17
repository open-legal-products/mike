import { describe, expect, it, vi } from "vitest";
import type { TextCardEvent } from "@mike/contracts";

type StreamParams = {
  tools: { function: { name: string } }[];
  callbacks: { onContentDelta: (text: string) => void };
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

import { runLLMStream } from "../streaming";
import {
  isMeaningfulTextlessAssistantOutput,
  stripTransientAssistantEvents,
} from "../contextBuilders";
import { runToolCalls } from "../tools/toolDispatcher";
import { textCardEvent } from "../tools/textCard";

const card: TextCardEvent = {
  type: "text_card",
  card_id: "card-1",
  title: "Draft email",
  text: "Dear Alex,\n\n  Please review the attached draft.\n\nThanks,\nSam\n",
};

describe("create_text_card", () => {
  it("streams and persists cards between surrounding prose, including multiple cards", async () => {
    streamChatWithTools.mockImplementationOnce(
      async ({ tools, callbacks, runTools }) => {
        expect(
          tools.some((tool) => tool.function.name === "create_text_card"),
        ).toBe(true);
        callbacks.onContentDelta("Here is a draft.");
        await runTools([
          {
            id: card.card_id,
            name: "create_text_card",
            input: { title: card.title, text: card.text },
          },
        ]);
        callbacks.onContentDelta("Or use this shorter version.");
        await runTools([
          {
            id: "card-2",
            name: "create_text_card",
            input: { title: "Short version", text: "Please review the draft." },
          },
        ]);
        callbacks.onContentDelta("Adjust the greeting before sending.");
        return { fullText: "" };
      },
    );
    const write = vi.fn();
    const { events } = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Draft an email." }],
      docStore: new Map(),
      docIndex: {},
      userId: "user-1",
      db: {} as never,
      write,
      includeAskInputs: false,
      allowDocumentMutation: false,
    });
    expect(events).toEqual([
      { type: "content", text: "Here is a draft." },
      card,
      { type: "content", text: "Or use this shorter version." },
      {
        type: "text_card",
        card_id: "card-2",
        title: "Short version",
        text: "Please review the draft.",
      },
      { type: "content", text: "Adjust the greeting before sending." },
    ]);
    expect(stripTransientAssistantEvents(events)).toEqual(events);
    expect(isMeaningfulTextlessAssistantOutput(card)).toBe(true);
    expect(write.mock.calls.map(([frame]) => frame).join("")).toContain(
      `data: ${JSON.stringify(card)}\n\n`,
    );
  });

  it("returns a display receipt without creating a document", async () => {
    const write = vi.fn();
    const result = await runToolCalls(
      [
        {
          id: card.card_id,
          function: {
            name: "create_text_card",
            arguments: JSON.stringify({
              title: " Draft email ",
              text: card.text,
            }),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      write,
    );
    expect(result.textCardEvents).toEqual([card]);
    expect(result.docsCreated).toEqual([]);
    expect(result.toolResults).toEqual([
      {
        role: "tool",
        tool_call_id: card.card_id,
        content: JSON.stringify({ card_id: card.card_id, displayed: true }),
      },
    ]);
  });

  it.each([
    null,
    [],
    {},
    { title: " ", text: "Draft" },
    { title: "Draft", text: "\n" },
    { title: "x".repeat(201), text: "Draft" },
    { title: "Draft", text: "x".repeat(100001) },
  ])("rejects invalid card input %# without emitting a card", async (args) => {
    expect(textCardEvent("bad", args)).toBeNull();
    const write = vi.fn();
    const result = await runToolCalls(
      [
        {
          id: "bad",
          function: {
            name: "create_text_card",
            arguments: JSON.stringify(args),
          },
        },
      ],
      new Map(),
      "user-1",
      {} as never,
      write,
    );
    expect(result.textCardEvents).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(result.toolResults[0]).toMatchObject({
      content: expect.stringContaining("Provide a non-empty title"),
    });
  });
});
