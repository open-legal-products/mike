import { expect, it } from "vitest";
import { tableDb } from "../../__tests__/helpers/tableDb";
import { readFolderSubtree } from "../folderSubtree";

it("reads a subtree's folders level by level and all their documents, in scope", async () => {
  const fake = tableDb({
    folders: [
      { id: "r", scope: "s", parent_folder_id: null },
      { id: "c", scope: "s", parent_folder_id: "r" },
      { id: "g", scope: "s", parent_folder_id: "c" },
      { id: "x", scope: "other", parent_folder_id: "r" },
    ],
    docs: Array.from({ length: 1200 }, (_, i) => ({ id: `d${String(i).padStart(4, "0")}`, scope: "s", folder: i % 2 ? "g" : "r" })),
  });
  const { folderIds, documents } = await readFolderSubtree<{ id: string }>({
    label: "subtree",
    rootId: "r",
    childrenOf: (parents) => fake.db.from("folders").select("id").eq("scope", "s").in("parent_folder_id", parents),
    documentsIn: (folders) => fake.db.from("docs").select("id").eq("scope", "s").in("folder", folders),
  });
  expect(folderIds).toEqual(["r", "c", "g"]);
  expect(documents).toHaveLength(1200);
});
