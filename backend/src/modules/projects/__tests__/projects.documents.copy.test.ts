import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";

const mocks = vi.hoisted(() => ({
  projectAccess: vi.fn(),
  docAccess: vi.fn(),
  downloadFile: vi.fn(),
}));
vi.mock("../../../lib/access", async (original) => ({
  ...(await original<typeof import("../../../lib/access")>()),
  checkProjectAccess: mocks.projectAccess,
  ensureDocAccess: mocks.docAccess,
}));
vi.mock("../../../lib/documentVersions", async (original) => ({
  ...(await original<typeof import("../../../lib/documentVersions")>()),
  attachActiveVersionPaths: vi.fn(),
}));
vi.mock("../../../lib/storage", async (original) => ({
  ...(await original<typeof import("../../../lib/storage")>()),
  downloadFile: mocks.downloadFile,
}));
import { assignOrCopyDocument } from "../projects.service";

const firmDoc = {
  id: "doc",
  user_id: "actor",
  project_id: "firm-matter",
  org_id: "firm",
  workflow_id: null,
  current_version_id: "v1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projectAccess.mockResolvedValue({
    ok: true,
    projectRole: "owner",
    project: { org_id: "firm" },
  });
});

// What the workspace check reads about the source: where it is filed, its
// project's organization, and which of those organizations are personal.
const placementReads = [
  { table: "documents", data: [firmDoc] },
  { table: "projects", data: [{ id: "firm-matter", org_id: "firm" }] },
  { table: "organizations", data: [{ id: "firm", kind: "team" }] },
];

describe("adding a document to a project by id", () => {
  // Authorship is provenance, not access: a document the caller wrote inside
  // a firm matter stays the firm's after the caller leaves or is denied it.
  it("refuses to copy a document out of a project the author can no longer reach", async () => {
    mocks.docAccess.mockResolvedValue({ ok: false });
    const fake = scriptedDb([{ table: "documents", data: firmDoc }]);
    expect(
      await assignOrCopyDocument(fake.db, {
        projectId: "personal",
        documentId: "doc",
        userId: "actor",
        userEmail: "actor@example.com",
      }),
    ).toEqual({ ok: false, kind: "doc_not_found" });
    expect(mocks.docAccess).toHaveBeenCalledWith(
      firmDoc,
      "actor",
      "actor@example.com",
      fake.db,
    );
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    fake.done();
  });

  it("still copies when the author keeps access to the source", async () => {
    mocks.docAccess.mockResolvedValue({
      ok: true,
      isCreator: true,
      orgRole: "member",
      projectRole: "viewer",
    });
    // Stop right after the gate: the source version read is the first step
    // the copy takes once access is established.
    const fake = scriptedDb([
      { table: "documents", data: firmDoc },
      ...placementReads,
      { table: "document_versions", data: null },
    ]);
    expect(
      await assignOrCopyDocument(fake.db, {
        projectId: "other-firm-matter",
        documentId: "doc",
        userId: "actor",
      }),
    ).toEqual({ ok: false, kind: "no_active_version" });
    fake.done();
  });

  // Access to the source is not enough to take it somewhere else: the firm's
  // document stays in the firm's workspace.
  it("refuses to copy an organization's document into a personal project", async () => {
    mocks.projectAccess.mockResolvedValue({
      ok: true,
      projectRole: "owner",
      project: { org_id: null },
    });
    mocks.docAccess.mockResolvedValue({
      ok: true,
      isCreator: true,
      orgRole: "member",
      projectRole: "editor",
    });
    const fake = scriptedDb([
      { table: "documents", data: firmDoc },
      ...placementReads,
    ]);
    expect(
      await assignOrCopyDocument(fake.db, {
        projectId: "personal",
        documentId: "doc",
        userId: "actor",
      }),
    ).toEqual({ ok: false, kind: "workspace_mismatch" });
    expect(mocks.downloadFile).not.toHaveBeenCalled();
    fake.done();
  });

  it("refuses to move a personal document into an organization's project", async () => {
    const personalDoc = { ...firmDoc, project_id: null, org_id: null };
    mocks.docAccess.mockResolvedValue({
      ok: true,
      isCreator: true,
      orgRole: null,
      projectRole: "owner",
    });
    const fake = scriptedDb([
      { table: "documents", data: personalDoc },
      { table: "documents", data: [personalDoc] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
    ]);
    expect(
      await assignOrCopyDocument(fake.db, {
        projectId: "firm-matter",
        documentId: "doc",
        userId: "actor",
      }),
    ).toEqual({ ok: false, kind: "workspace_mismatch" });
    // Nothing was written: the script holds no update.
    fake.done();
  });
});

it.each([
  { workflow_id: "workflow", library_kind: null },
  { workflow_id: null, library_kind: "template" },
])("copies rather than reassigning a workflow asset or template: %j", async placement => {
  mocks.projectAccess.mockResolvedValue({ ok: true, projectRole: "owner", project: { org_id: null } });
  mocks.docAccess.mockResolvedValue({ ok: true, projectRole: "owner", isCreator: true });
  const source = { ...firmDoc, project_id: null, org_id: null, ...placement };
  const fake = scriptedDb([
    { table: "documents", data: source },
    { table: "documents", data: [source] },
    { table: "document_versions", data: null },
  ]);
  expect(await assignOrCopyDocument(fake.db, { projectId: "destination", documentId: "doc", userId: "actor" }))
    .toEqual({ ok: false, kind: "no_active_version" });
  expect(fake.calls.some(c => c.table === "documents" && c.op === "update")).toBe(false);
  fake.done();
});
