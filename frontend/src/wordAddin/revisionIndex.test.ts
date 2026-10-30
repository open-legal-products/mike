import { describe, expect, it } from "vitest";
import { createRevisionIndex } from "../../../word-addin/src/taskpane/lib/revisionIndex";

describe("fresh Word revision index", () => {
  it("normalizes host line breaks and retains duplicates for ambiguity checks", () => {
    const changes = [{ type: "deleted", text: "old\r\n" }, { type: "added", text: "new" }, { type: "added", text: "new" }];
    const index = createRevisionIndex(changes, c => c.type, c => c.text);
    expect(index.deleted("old")).toEqual([changes[0]]);
    expect(index.deleted("old\n")).toEqual([changes[0]]);
    expect(index.matching("added", "new")).toHaveLength(2);
    expect(index.joined("deleted")).toBe("old\n");
    expect(index.all("formatted")).toEqual([]);
  });
  it("reads each host revision once rather than once per restored edit", () => {
    for (const n of [100, 200, 400]) {
      let reads = 0;
      const changes = Array.from({ length: n }, (_, i) => ({ type: "Insert", get text() { reads++; return `text-${i}`; } }));
      const index = createRevisionIndex(changes, c => c.type, c => c.text);
      for (let i = 0; i < n; i++) expect(index.matching("Insert", `text-${i}`)).toEqual([changes[i]]);
      expect(reads).toBe(n);
    }
  });
  it("indexes paragraph-mark deletes on both Word revision APIs", () => {
    const change = { type: "Delete", text: "clause\r" };
    const index = createRevisionIndex([change], c => c.type, c => c.text);
    expect(index.deleted("clause")).toEqual([change]);
    expect(index.deleted("different")).toEqual([]);
    expect(index.all("Delete")).toEqual([change]);
  });
});
