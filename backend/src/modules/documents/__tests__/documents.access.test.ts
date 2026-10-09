import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { ensureDocAccess } from "../../../lib/access";
import { deleteDocument, getDocument } from "../documents.access";
vi.mock("../../../lib/access", async (load) => ({ ...(await load<object>()), ensureDocAccess: vi.fn() }));
vi.mock("../../../lib/documentVersions", () => ({ attachActiveVersionPaths: vi.fn(), attachLatestVersionNumbers: vi.fn() }));
describe("document detail permissions", () => {
  it.each([
    ["viewer", false, "owner-id", null, false, false],
    ["editor", false, "owner-id", null, false, false],
    ["owner", true, "user", null, true, true],
    ["owner", false, null, null, true, true],
    ["editor", false, "owner-id", "workflow", true, true],
    // A creator downgraded to Viewer keeps provenance, not the right to
    // replace or destroy content in the project.
    ["viewer", true, "user", null, false, false],
  ] as const)("matches upload replacement and deletion rights (%s, creator %s)", async (projectRole, isCreator, creatorId, workflowId, canEdit, canDelete) => {
    vi.mocked(ensureDocAccess).mockResolvedValue({ ok: true, projectRole, isCreator, orgRole: null });
    const fake = scriptedDb([{ table: "documents", data: { id: "doc", user_id: creatorId, project_id: "project", workflow_id: workflowId } }]);
    expect(await getDocument("doc", "user", undefined, fake.db)).toMatchObject({ ok: true, doc: { can_edit: canEdit, can_delete: canDelete } });
    fake.done();
  });
});

describe("document deletion permissions", () => {
  it("refuses a creator whose project role was reduced to viewer", async () => {
    vi.mocked(ensureDocAccess).mockResolvedValue({ ok: true, projectRole: "viewer", isCreator: true, orgRole: null });
    const fake = scriptedDb([{ table: "documents", data: { id: "doc", user_id: "user", project_id: "project", workflow_id: null } }]);
    expect(await deleteDocument("doc", "user", fake.db)).toMatchObject({ ok: false, kind: "forbidden" });
    fake.done();
  });
});
