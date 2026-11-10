import { expect, it, vi } from "vitest";
import type { Db } from "../../../../lib/supabase";

const { runEditDocument } = vi.hoisted(() => ({ runEditDocument: vi.fn() }));
vi.mock("../tools/documentOps", async (original) => ({
  ...(await original<typeof import("../tools/documentOps")>()),
  runEditDocument,
}));

import { scriptedDb } from "../../../../__tests__/helpers/scriptedDb";
import { createKeyedLock } from "../tools/documentLocks";
import { getTurnReadIdentity } from "../tools/documentOps";
import { runToolCalls } from "../tools/toolDispatcher";

it("lands two concurrent edits to one document, the second on top of the first", async () => {
  let versions = 1;
  runEditDocument.mockImplementation(async ({ reuseVersion }) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const versionNumber = reuseVersion?.versionNumber ?? ++versions;
    return {
      ok: true,
      version_id: reuseVersion?.versionId ?? `v${versionNumber}`,
      version_number: versionNumber,
      storage_path: `edit-${runEditDocument.mock.calls.length}`,
      download_url: "",
      annotations: [],
      errors: [],
    };
  });
  const docStore = new Map([["doc-0", { filename: "Lease.docx", file_type: "docx" }]]) as never;
  const docIndex = { "doc-0": { document_id: "d1", version_id: "v1", version_number: 1 } } as never;
  const turnEditState = new Map();
  const documentLocks = createKeyedLock();
  const edit = (id: string) =>
    runToolCalls(
      [
        {
          id,
          function: {
            name: "edit_document",
            arguments: JSON.stringify({ doc_id: "doc-0", edits: [{ find: id, replace: "x" }] }),
          },
        },
      ],
      docStore,
      "u1",
      {} as Db,
      vi.fn(),
      undefined,
      undefined,
      docIndex,
      turnEditState,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { documentLocks },
    );

  await Promise.all([edit("first"), edit("second")]);

  const [first, second] = runEditDocument.mock.calls.map(([args]) => args.reuseVersion);
  expect(first).toBeUndefined();
  expect(second).toEqual({ versionId: "v2", versionNumber: 2, storagePath: "edit-1" });
});

it("reads a document again once another edit moves its reused version to a new file", async () => {
  const activeVersion = (storage_path: string) => [
    { table: "documents", data: { current_version_id: "v2" } },
    { table: "document_versions", data: { id: "v2", document_id: "d1", version_number: 2, storage_path } },
  ];
  const { db } = scriptedDb([...activeVersion("edit-1"), ...activeVersion("edit-2")]);
  const readKey = async () =>
    (await getTurnReadIdentity({
      docLabel: "doc-0",
      docStore: new Map([["doc-0", { filename: "Lease.docx", file_type: "docx", storage_path: "edit-1" }]]),
      docIndex: { "doc-0": { document_id: "d1", version_id: "v2", version_number: 2 } } as never,
      db,
    }))?.key;

  expect(await readKey()).not.toBe(await readKey());
});
