import { describe, expect, it } from "vitest";
import { collectFolderDescendantIds } from "../documents.service";

describe("collectFolderDescendantIds", () => {
  it("includes every nested descendant and excludes unrelated folders", () => {
    const ids = collectFolderDescendantIds(
      [{ id: "folder-root" }],
      [
        { id: "folder-root", parent_folder_id: null },
        { id: "folder-child", parent_folder_id: "folder-root" },
        { id: "folder-grandchild", parent_folder_id: "folder-child" },
        { id: "folder-unrelated", parent_folder_id: null },
      ],
    );

    expect(ids).toEqual([
      "folder-root",
      "folder-child",
      "folder-grandchild",
    ]);
  });
});
