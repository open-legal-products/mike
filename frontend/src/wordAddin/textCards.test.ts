/// <reference types="office-runtime" />
import { describe, expect, it, vi } from "vitest";

import type {
  WordAssistantEvent,
  WordTextCardEvent,
} from "../../../word-addin/src/taskpane/types";
import {
  appendAssistantContent,
  assistantContentForModel,
  completeAssistantEvents,
  isWordTextCardEvent,
  normalizeStoredAssistantEvents,
} from "../../../word-addin/src/taskpane/lib/wordChatEvents";

const { open, resume } = vi.hoisted(() => ({ open: vi.fn(), resume: vi.fn() }));
vi.mock("../../../word-addin/src/taskpane/api/mikeApi", async () => ({
  readSSE: (await import("../../../word-addin/src/taskpane/api/client"))
    .readSSE,
  streamWordChat: open,
  streamWordChatTurn: resume,
}));
import {
  streamAssistant,
  resumeAssistant,
} from "../../../word-addin/src/taskpane/api/stream";

const card: WordTextCardEvent = {
  type: "text_card",
  card_id: "card-1",
  title: "Draft",
  text: "First paragraph.\n\n  Second paragraph.\n",
};

describe("Word text cards", () => {
  it.each(["fresh", "resumed"])(
    "places cards in a %s stream and retains them on reload",
    async (kind) => {
      const frames = [
        { type: "content_delta", text: "Before." },
        card,
        { type: "text_card", title: "Incomplete" },
        { type: "content_delta", text: "After." },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      const response = new Response(`${frames}data: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
      open.mockResolvedValueOnce(response);
      resume.mockResolvedValueOnce(response);
      let events: WordAssistantEvent[] = [
        { type: "thinking", isStreaming: true },
      ];
      const onText = (text: string) => {
        events = appendAssistantContent(events, text);
      };
      const onTextCard = (event: WordTextCardEvent) => {
        events = [...completeAssistantEvents(events), event];
      };
      if (kind === "fresh") {
        await streamAssistant(
          {
            messages: [],
            model: "test-model",
            wordDocumentId: "doc-1",
            documentName: "Test",
            wordChatStorage: "cloud",
            onTextCard,
          },
          onText,
        );
      } else {
        await resumeAssistant(
          {
            chatId: "chat-1",
            turnId: "turn-1",
            documentId: "doc-1",
            onTextCard,
          },
          onText,
        );
      }
      expect(events).toEqual([
        { type: "content", text: "Before.", key: expect.any(String) },
        card,
        { type: "content", text: "After.", key: expect.any(String) },
      ]);
      const reloaded = normalizeStoredAssistantEvents(
        JSON.parse(JSON.stringify(completeAssistantEvents(events))),
      );
      expect(reloaded).toEqual(events);
      expect(isWordTextCardEvent(reloaded[1])).toBe(true);
      expect(
        assistantContentForModel({
          id: "answer-1",
          role: "assistant",
          events: reloaded,
        }),
      ).toBe(`Before.\n\nDraft\n${card.text}\n\nAfter.`);
      open.mockReset();
      resume.mockReset();
    },
  );

  it("retains a card-only answer in follow-up history", () => {
    expect(
      assistantContentForModel({
        id: "answer-1",
        role: "assistant",
        events: [card],
      }),
    ).toBe(`Draft\n${card.text}`);
    expect(
      isWordTextCardEvent({ type: "text_card", title: "Incomplete" }),
    ).toBe(false);
  });
});
