import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { setStorageAdapter, StorageOperationError } from "../../../lib/storage";
import type { DbJob } from "../../../lib/dbq/types";

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureDocAccess: async () => ({ ok: true }),
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: async (id: string) => ({ storage_path: `${id}.docx`, filename: `${id}.docx`, version_number: 1, source: "upload" }),
}));
import { handleExportBuild } from "../user.exportJobs";

const download = vi.fn<(key: string) => Promise<ArrayBuffer | null>>();
const upload = vi.fn<(key: string, bytes: ArrayBuffer, contentType: string) => Promise<void>>();
const job: DbJob = {
  id: "export-1", kind: "export.build",
  payload: { userId: "u1", type: "documents-zip", document_ids: ["d1", "d2"] },
  status: "running", attempts: 1, max_attempts: 3, run_at: "", claimed_at: null,
  finished_at: null, last_error: null, dedupe_key: null, result: null, created_at: "",
};
const db = {
  from: () => ({ select: () => ({ in: async () => ({ data: ["d1", "d2"].map(id => ({ id, user_id: "u1", project_id: null })), error: null }) }) }),
};

beforeEach(() => {
  download.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer);
  upload.mockReset().mockResolvedValue(undefined);
  setStorageAdapter({ enabled: true, configurationHint: "test", downloadFile: download, uploadFile: upload } as never);
});

describe("required document export reads", () => {
  it.each(["ECONNRESET", "AccessDenied"])("fails before publishing a partial ZIP when a selected document read fails with %s", async code => {
    download.mockResolvedValueOnce(new Uint8Array([1]).buffer).mockRejectedValueOnce(Object.assign(new Error("storage failure"), { code }));
    await expect(handleExportBuild(db as never, job)).rejects.toBeInstanceOf(StorageOperationError);
    expect(upload).not.toHaveBeenCalled();
  });

  it("publishes both selected files when their reads succeed", async () => {
    await expect(handleExportBuild(db as never, job)).resolves.toMatchObject({ filename: "documents.zip" });
    expect(upload).toHaveBeenCalledOnce();
    const zip = await JSZip.loadAsync(upload.mock.calls[0]![1]);
    expect(Object.keys(zip.files)).toEqual(["d1.docx", "d2.docx"]);
  });
});
