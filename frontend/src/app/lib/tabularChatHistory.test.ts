import { describe, expect, it } from "vitest";
import { buildTabularChatHistory } from "./tabularChatHistory";

describe("buildTabularChatHistory", () => {
  it("restores in-session assistant text from content events", () => {
    expect(
      buildTabularChatHistory([
        { role: "user", content: "First question" },
        {
          role: "assistant",
          content: "",
          events: [
            { type: "content", text: "First " },
            { type: "reasoning", text: "not replayed" },
            { type: "content", text: "answer" },
          ],
        },
        { role: "user", content: "Follow-up" },
      ]),
    ).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Follow-up" },
    ]);
  });
});
