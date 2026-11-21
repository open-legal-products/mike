import { expect, it } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { getLibraryFolderPath } from "../library.service";

it("resolves a breadcrumb by walking parents, even past max_rows library folders", async () => {
  const folders = Array.from({ length: 1500 }, (_, i) => ({
    id: `f${String(i).padStart(4, "0")}`, user_id: "u", library_kind: "file", org_id: null,
    name: `F${i}`, parent_folder_id: i === 1499 ? "f1498" : i === 1498 ? "f0003" : null,
  }));
  const fake = tableDb({ library_folders: folders });
  const result = await getLibraryFolderPath(fake.db, "u", "file", "f1499");
  expect(result.ok && (result.data.folders as { id: string }[]).map((f) => f.id)).toEqual(["f0003", "f1498", "f1499"]);
  // One read per level, never the whole library.
  expect(fake.calls.reduce((rows, call) => rows + call.returned, 0)).toBe(3);
});
