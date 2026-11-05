import { expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";
vi.mock("../../../lib/access", async (original) => ({
  ...(await original<typeof import("../../../lib/access")>()),
  checkProjectAccess: vi.fn(async () => ({ ok: true, projectRole: "owner" })),
}));
vi.mock("../../../lib/dbq/enqueue", async (original) => ({
  ...(await original<typeof import("../../../lib/dbq/enqueue")>()),
  requestDocumentCleanupDelivery: vi.fn(async () => {}),
}));
import { deleteProjectFolder } from "../projects.service";

it("deletes every document of a folder subtree past max_rows instead of orphaning the rest", async () => {
  const docs = Array.from({ length: 1200 }, (_, i) => ({
    id: `doc-${String(i).padStart(4, "0")}`, project_id: "p", user_id: "actor", folder_id: i % 2 ? "root" : "child",
  }));
  const fake = tableDb({
    project_subfolders: [
      { id: "root", project_id: "p", parent_folder_id: null },
      { id: "child", project_id: "p", parent_folder_id: "root" },
      { id: "elsewhere", project_id: "p", parent_folder_id: null },
    ],
    documents: [...docs, { id: "keep", project_id: "p", user_id: "actor", folder_id: "elsewhere" }],
  });
  expect(await deleteProjectFolder(fake.db, { userId: "actor", projectId: "p", folderId: "root" })).toEqual({ ok: true });
  expect(fake.tables.documents.map((doc) => doc.id)).toEqual(["keep"]);
});
