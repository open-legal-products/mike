import { describe, expect, it } from "vitest";
import { buildStoppedAssistantMessage } from "./contextBuilders";
import { deadlineMessage } from "../../../lib/streamRuns";

describe("stored stop outcomes", () => {
  it.each(["idle", "max_lifetime"] as const)(
    "preserves %s as a safe error with partial content and citations",
    (stopReason) => {
      const result = buildStoppedAssistantMessage({
        stopReason,
        fullText: "Partial answer",
        events: [{ type: "content", text: "Partial answer" }],
        buildCitations: () => [],
      });
      expect(result.events).toEqual([
        { type: "content", text: "Partial answer" },
        {
          type: "error",
          message: deadlineMessage(stopReason),
          safe_to_display: true,
        },
      ]);
      expect(result.citations).toEqual([]);
    },
  );

  it("keeps explicit user cancellation distinct", () => {
    const result = buildStoppedAssistantMessage({
      stopReason: "user",
      fullText: "",
      events: [],
      buildCitations: () => [],
    });
    expect(result.events).toEqual([
      { type: "content", text: "Cancelled by user." },
    ]);
  });
});
