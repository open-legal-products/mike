import { expect, it, vi } from "vitest";
import JSZip from "jszip";
import { setStorageAdapter } from "../../../lib/storage";
import type { DbJob } from "../../../lib/dbq/types";
import { tableDb } from "../../../__tests__/helpers/tableDb";

const checks = vi.hoisted(() => ({ count: 0 }));
vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureDocAccess: async () => (checks.count++, { ok: true }),
  createDocumentAccessChecker: () => async () => (checks.count++, { ok: true }),
}));
import { handleExportBuild } from "../user.exportJobs";

it("exports a 120-document selection with batched lookups instead of two reads per document", async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `d${String(i).padStart(3, "0")}`);
  const fake = tableDb({
    documents: ids.map((id) => ({ id, user_id: "u1", project_id: null, current_version_id: `v-${id}` })),
    document_versions: ids.map((id) => ({ id: `v-${id}`, document_id: id, storage_path: `${id}.docx`, filename: `${id}.docx`, version_number: 1, deleted_at: null })),
  });
  const upload = vi.fn(async () => {});
  setStorageAdapter({ enabled: true, configurationHint: "test", downloadFile: async () => new Uint8Array([1]).buffer, uploadFile: upload } as never);
  const job = {
    id: "export-1", kind: "export.build", payload: { userId: "u1", type: "documents-zip", document_ids: ids },
    status: "running", attempts: 1, max_attempts: 3,
  } as unknown as DbJob;
  await handleExportBuild(fake.db, job);
  const zip = await JSZip.loadAsync((upload.mock.calls[0] as unknown[])[1] as ArrayBuffer);
  expect(Object.keys(zip.files)).toHaveLength(120);
  // 3 document batches + 3 version batches; the old loop issued 1 + 240.
  expect(fake.calls).toHaveLength(6);
});
