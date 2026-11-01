import { describe, expect, it, vi } from "vitest";
import {
  folderPathResolver,
  parseFolderPath,
  validateFolderMove,
  walkFolderGraph,
} from "../folderTree";

describe("folder path rules", () => {
  it.each([
    undefined,
    null,
    "a/b",
    [],
    [""],
    ["a", 2],
    ["x".repeat(256)],
    Array(101).fill("a"),
  ])("rejects malformed segments %j", (segments) => {
    expect(parseFolderPath({ segments })).toBeNull();
  });
  it.each(["reuse", "rename", "error", "replace"])(
    "normalizes paths and collision policy %s",
    (conflict_resolution) => {
      expect(
        parseFolderPath({
          segments: [" Contracts ", "NDAs"],
          base_folder_id: " root ",
          conflict_resolution,
        }),
      ).toEqual({
        segments: ["Contracts", "NDAs"],
        baseFolderId: "root",
        conflictResolution:
          conflict_resolution === "replace" ? "error" : conflict_resolution,
      });
    },
  );
  it("accepts boundary lengths and treats an empty base as root", () => {
    expect(
      parseFolderPath({
        segments: Array(100).fill("x".repeat(255)),
        base_folder_id: " ",
      }),
    ).toMatchObject({ baseFolderId: null });
  });
});
describe("folder move ancestry", () => {
  it("rejects self moves without querying", async () => {
    const load = vi.fn();
    expect(await validateFolderMove("a", "a", load)).toBe("cycle");
    expect(load).not.toHaveBeenCalled();
  });
  it("rejects moving into a descendant", async () => {
    expect(
      await validateFolderMove("a", "child", async () => ({
        parent_folder_id: "a",
      })),
    ).toBe("cycle");
  });
  it("terminates on a pre-existing ancestor cycle", async () => {
    const load = vi.fn(async (id: string) => ({
      parent_folder_id: id === "b" ? "c" : "b",
    }));
    expect(await validateFolderMove("a", "b", load)).toBe("cycle");
    expect(load).toHaveBeenCalledTimes(2);
  });
  it("rejects a parent missing from the caller's scope", async () => {
    expect(await validateFolderMove("a", "foreign", async () => null)).toBe(
      "parent_not_found",
    );
  });
  it("allows moving beneath a valid ancestor chain", async () => {
    expect(
      await validateFolderMove("a", "b", async (id) => ({
        parent_folder_id: id === "b" ? "root" : null,
      })),
    ).toBeNull();
  });
});
describe("walkFolderGraph", () => {
  it("loads one level per call and stops on a parent cycle", async () => {
    const parent: Record<string, string | null> = { a: "b", b: "c", c: "a", d: null };
    const levels: string[][] = [];
    const rows = await walkFolderGraph(
      ["a", "d"],
      async (ids) => (levels.push(ids), ids.map((id) => ({ id, parent_folder_id: parent[id] }))),
      (row) => [row.parent_folder_id],
    );
    expect(levels).toEqual([["a", "d"], ["b"], ["c"]]);
    expect(rows.map((row) => row.id)).toEqual(["a", "d", "b", "c"]);
  });
});

describe("folderPathResolver", () => {
  it("walks each ancestor once across many lookups and stops at a cycle", () => {
    const folders = Array.from({ length: 100 }, (_, i) => ({
      id: `f${i}`,
      name: `F${i}`,
      parent_folder_id: i === 0 ? null : `f${i - 1}`,
    }));
    const resolve = folderPathResolver(folders);
    // Every hop up the tree is one Map lookup; re-walking each chain from the
    // leaf costs ~n²/2 = 5,000 for a 100-deep tree.
    const lookups = vi.spyOn(Map.prototype, "get");
    try {
      for (const folder of folders) resolve(folder.id);
      expect(lookups.mock.calls.length).toBeLessThan(1_000);
    } finally {
      lookups.mockRestore();
    }
    expect(resolve("f2")).toBe("F0 / F1 / F2");
    expect(resolve("missing")).toBe("");
    expect(resolve(null)).toBe("");

    const cyclic = folderPathResolver([
      { id: "a", name: "A", parent_folder_id: "b" },
      { id: "b", name: "B", parent_folder_id: "a" },
    ]);
    expect(cyclic("a")).toBe("B / A");
  });
});
