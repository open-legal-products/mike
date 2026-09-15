import { describe, expect, it, vi } from "vitest";
import {
  collectFolderSubtree,
  parseFolderPath,
  validateFolderMove,
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
it("collects only the selected subtree, retains traversal order, and terminates on cycles", () => {
  expect([
    ...collectFolderSubtree("root", [
      { id: "root", parent_folder_id: "grandchild" },
      { id: "a", parent_folder_id: "root" },
      { id: "b", parent_folder_id: "root" },
      { id: "grandchild", parent_folder_id: "a" },
      { id: "other", parent_folder_id: null },
    ]),
  ]).toEqual(["root", "b", "a", "grandchild"]);
});
