import { describe, expect, it } from "vitest";
import { buildDirectoryIndex } from "../../../word-addin/src/taskpane/lib/directoryIndex";

describe("Word directory index", () => {
  it("aggregates loaded/selected descendants while preserving collection order", () => {
    const folders = [{ id: "a" }, { id: "b", parent_folder_id: "a" }, { id: "c", parent_folder_id: "a" }];
    const docs = [{ id: "one", library_folder_id: "a" }, { id: "two", folder_id: "b" }, { id: "three", folder_id: "c" }];
    const index = buildDirectoryIndex(folders, docs, new Set(["two"]), id => id !== "c");
    expect(index.summaries.get("a")).toEqual({ count: 3, selected: 1, loaded: false });
    expect(index.collect("a").map(d => d.id)).toEqual(["one", "two", "three"]);
    expect(index.summaries.get("b")).toEqual({ count: 1, selected: 1, loaded: true });
  });
  it("visits each folder and document once even for a deep reversed chain", () => {
    for (const n of [100, 200, 400]) {
      let parents = 0, selections = 0, loads = 0;
      const folders = Array.from({ length: n }, (_, i) => ({ id: `${i}`, get parent_folder_id() { parents++; return i ? `${i - 1}` : null; } })).reverse();
      const docs = folders.map(folder => ({ id: folder.id, folder_id: folder.id }));
      const selected = new Set(docs.map(d => d.id));
      const has = selected.has.bind(selected);
      selected.has = id => { selections++; return has(id); };
      const index = buildDirectoryIndex(folders, docs, selected, () => { loads++; return true; });
      expect(index.summaries.get("0")).toEqual({ count: n, selected: n, loaded: true });
      expect({ parents, selections, loads }).toEqual({ parents: n, selections: n, loads: n });
      expect(index.collect("0")).toHaveLength(n);
    }
  });
  it("does not mark a cyclic imported tree as completely loaded", () => {
    const index = buildDirectoryIndex([{ id: "a", parent_folder_id: "b" }, { id: "b", parent_folder_id: "a" }], [], new Set(), () => true);
    expect(index.summaries.get("a")?.loaded).toBe(false);
    expect(index.collect("a")).toEqual([]);
  });
});
