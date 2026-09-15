import { describe, expect, it } from "vitest";
import { assistantHistoryContent } from "./assistantHistoryContent";

describe("assistantHistoryContent", () => {
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
