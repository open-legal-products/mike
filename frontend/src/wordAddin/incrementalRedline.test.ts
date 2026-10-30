import { describe, expect, it } from "vitest";
import { createRedlineStreamProjector, projectRedlineStream } from "../../../word-addin/src/taskpane/lib/redline";
import { createMessageEditStateSelector } from "../../../word-addin/src/taskpane/lib/messageEditState";

const edit = { type: "edit_data", kind: "edit", deleted_text: "old", inserted_text: "new" };
describe("incremental Word redline projection", () => {
  it.each([
    `Before\n\n<EDITS>[${JSON.stringify(edit)}]</EDITS>\n\nAfter`,
    `<edits>[${JSON.stringify({ ...edit, inserted_text: 'quote " \\ brace }' })}, ${JSON.stringify({ ...edit, deleted_text: "other" })}]</edits>`,
    `<edits>[${JSON.stringify(edit)}, ${JSON.stringify(edit)}, {"broken":true}]</edits>`,
    `<edits>[1, false, ${JSON.stringify(edit)}]</edits>`,
  ])("matches the complete parser at every byte boundary: %s", text => {
    const parser = createRedlineStreamProjector();
    for (let i = 0; i < text.length; i++) expect(parser.append(text[i])).toEqual(projectRedlineStream(text.slice(0, i + 1)));
  });
  it("scans growing incomplete JSON once and retains the previous immutable snapshot", () => {
    for (const n of [100, 200, 400]) {
      const parser = createRedlineStreamProjector();
      const before = parser.append('<edits>[{"type":"edit_data","kind":"edit","deleted_text":"old","inserted_text":"');
      const initialScans = parser.scannedCharacters;
      for (let i = 0; i < n; i++) expect(parser.append("x")).toBe(before);
      expect(parser.scannedCharacters - initialScans).toBe(n);
      const after = parser.append('"},');
      expect(after.edits[0]?.sealed).toBe(true);
      expect(before.edits[0]?.sealed).toBe(false);
    }
  });
});
describe("per-message edit state", () => {
  it("preserves completed message props when another message changes", () => {
    const select = createMessageEditStateSelector();
    const a = { status: "pending" as const }, b = { status: "receiving" as const };
    const first = select({ "a:edit-0": a, "b:edit-0": b });
    const next = select({ "a:edit-0": a, "b:edit-0": { status: "pending" } });
    expect(next.get("a")).toBe(first.get("a"));
    expect(next.get("b")).not.toBe(first.get("b"));
    expect(select({ "b:edit-0": b }).has("a")).toBe(false);
  });
});
