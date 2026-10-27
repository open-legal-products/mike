import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  ensureDocAccess: vi.fn(),
  loadActiveVersion: vi.fn(),
  uploadFile: vi.fn(),
  createDocumentVersion: vi.fn(),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));
vi.mock("../../../lib/storage", () => ({
  uploadFile: mocks.uploadFile,
}));
vi.mock("../documents.lifecycle", () => ({
  createDocumentVersion: mocks.createDocumentVersion,
}));

import { saveVisualVersion } from "../documents.visuals";

const document = { id: "d1", user_id: "u1", project_id: "p1", org_id: null, workflow_id: null, library_kind: "file" };
const active = { id: "v1", storage_path: "documents/u1/d1/edits/a.html", version_number: 1, filename: "Lease map.html", source: "generated", file_type: "html" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadActiveVersion.mockResolvedValue(active);
});

describe("saveVisualVersion", () => {
  it("refuses a project viewer before touching storage", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "viewer", orgRole: null, isCreator: false });
    const { db } = scriptedDb([{ table: "documents", data: document }]);

    const result = await saveVisualVersion(db, { documentId: "d1", userId: "u2", bytes: Buffer.from("<p>x</p>") });

    expect(result).toMatchObject({ ok: false, kind: "forbidden" });
    expect(mocks.uploadFile).not.toHaveBeenCalled();
  });
});
