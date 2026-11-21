import { expect, it, vi } from "vitest";
import { tableDb } from "../../../__tests__/helpers/tableDb";

vi.mock("../../../lib/access", async (original) => ({
  ...(await original<typeof import("../../../lib/access")>()),
  checkProjectAccess: vi.fn(async () => ({ ok: true })),
  createDocumentAccessChecker: () => async () => ({ ok: true }),
}));
vi.mock("../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../lib/storage")>()),
  headFile: vi.fn(async () => ({ size: 10 })),
}));
import { resolveZipExportDocuments } from "../documents.download";

it("exports a selected folder's whole subtree without reading the project's other folders", async () => {
  const folders = [
    { id: "root", project_id: "p", parent_folder_id: null },
    { id: "child", project_id: "p", parent_folder_id: "root" },
    { id: "grandchild", project_id: "p", parent_folder_id: "child" },
    ...Array.from({ length: 100 }, (_, i) => ({ id: `other-${i}`, project_id: "p", parent_folder_id: null })),
  ];
  const docs = ["root", "child", "grandchild", "other-0"].map((folder) => ({
    id: `doc-${folder}`, folder_id: folder, project_id: "p", user_id: "u", current_version_id: `v-${folder}`,
  }));
  const fake = tableDb({
    project_subfolders: folders,
    library_folders: [],
    documents: docs,
    document_versions: docs.map((doc) => ({ id: doc.current_version_id, storage_path: `${doc.id}.pdf`, filename: `${doc.id}.pdf`, deleted_at: null })),
  });
  const result = await resolveZipExportDocuments({ documentIds: [], folderIds: ["root"], userId: "u", userEmail: "u@example.com" }, fake.db);
  expect(result.ok && result.entries.map((entry) => entry.storagePath).sort()).toEqual([
    "doc-child.pdf", "doc-grandchild.pdf", "doc-root.pdf",
  ]);
  const folderRows = fake.calls.filter((call) => call.table === "project_subfolders").reduce((n, call) => n + call.returned, 0);
  expect(folderRows).toBeLessThanOrEqual(4);
});
