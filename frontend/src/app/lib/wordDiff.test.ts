import { describe, expect, it } from "vitest";
import { diffWords, type DiffSegment } from "./wordDiff";

function rebuild(segments: DiffSegment[], side: "before" | "after") {
  const skip = side === "before" ? "added" : "removed";
  return segments
    .filter((segment) => segment.type !== skip)
    .map((segment) => segment.text)
    .join("");
}

describe("diffWords", () => {
  it("marks only the words that changed", () => {
    const segments = diffWords(
      "Liability is unlimited for all claims.",
      "Liability is capped at fees paid for all claims.",
    );
    expect(segments).toEqual([
      { type: "equal", text: "Liability is " },
      { type: "removed", text: "unlimited " },
      { type: "added", text: "capped at fees paid " },
      { type: "equal", text: "for all claims." },
    ]);
  });

  it.each([
    ["The Supplier shall indemnify the Customer.", "The Customer shall indemnify the Supplier promptly."],
    ["", "A whole new clause."],
    ["A clause to delete.", ""],
    ["Same  text\nwith odd   spacing.", "Same  text\nwith odd   spacing."],
  ])("rebuilds both sides exactly from %j to %j", (before, after) => {
    const segments = diffWords(before, after);
    expect(rebuild(segments, "before")).toBe(before);
    expect(rebuild(segments, "after")).toBe(after);
  });

  it("treats identical text as unchanged and empty text as nothing", () => {
    expect(diffWords("No change.", "No change.")).toEqual([
      { type: "equal", text: "No change." },
    ]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("falls back to a whole replacement for very long text", () => {
    const before = "word ".repeat(1000);
    const after = "other ".repeat(1000);
    expect(diffWords(before, after)).toEqual([
      { type: "removed", text: before },
      { type: "added", text: after },
    ]);
  });
});
