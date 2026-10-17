import { describe, expect, it } from "vitest";
import { assistantHistoryContent } from "./assistantHistoryContent";

describe("assistantHistoryContent", () => {
  it.each(["", "Before.After."])("keeps card contents in history for live and reloaded turns (%s)", (content) => {
    expect(assistantHistoryContent({ content, events: [
      { type: "content", text: "Before." },
      { type: "text_card", card_id: "card-1", title: "Draft", text: "First paragraph.\n\nSecond paragraph." },
      { type: "content", text: "After." },
    ] })).toBe("Before.\n\nDraft\nFirst paragraph.\n\nSecond paragraph.\n\nAfter.");
  });
  it("keeps content that is already present", () => {
    expect(
      assistantHistoryContent({ content: "Hydrated", events: [] }),
    ).toBe("Hydrated");
  });

  it("joins the prose of a turn streamed in this session", () => {
    expect(
      assistantHistoryContent({
        content: "",
        events: [
          { type: "content", text: "A break clause " },
          { type: "tool_call", name: "read_document" } as never,
          { type: "content", text: "lets a party end early." },
        ],
      }),
    ).toBe("A break clause lets a party end early.");
  });

  it("is empty for an errored or cancelled turn", () => {
    expect(assistantHistoryContent({ content: "" })).toBe("");
  });
});
