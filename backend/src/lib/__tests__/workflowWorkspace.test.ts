import { describe, expect, it } from "vitest";
import { scriptedDb } from "../../__tests__/helpers/scriptedDb";
import { canUseWorkflowInWorkspace, listWorkspaceWorkflows } from "../workflowWorkspace";

const owned = { id: "wf", user_id: "u", org_id: null };

describe("workflow workspace authorization", () => {
  it("excludes a Personal workflow from an organization even for its owner", async () => {
    const fake = scriptedDb([{ table: "workflows", data: owned }]);
    expect(await canUseWorkflowInWorkspace(fake.db, "wf", "u", null, "firm")).toBe(false);
    fake.done();
  });

  it("excludes a directly shared workflow from an organization", async () => {
    const fake = scriptedDb([
      { table: "workflows", data: { ...owned, user_id: "someone" } },
      { table: "workflow_shares", data: { role: "viewer" } },
    ]);
    expect(await canUseWorkflowInWorkspace(fake.db, "wf", "u", "U@EXAMPLE.COM", "firm")).toBe(false);
    fake.done();
  });

  it.each(["personal", "other-firm"])("excludes an authorized organization workflow from %s", async workspace => {
    const fake = scriptedDb([
      { table: "workflows", data: { ...owned, org_id: "firm" } },
      { table: "org_members", data: { role: "member" } },
      { table: "organizations", data: { kind: "team" } },
    ]);
    expect(await canUseWorkflowInWorkspace(fake.db, "wf", "u", null, workspace)).toBe(false);
    fake.done();
  });

  it("refuses an owner's workflow when the organization is deleted or membership is revoked", async () => {
    const fake = scriptedDb([
      { table: "workflows", data: { ...owned, org_id: "firm" } },
      { table: "org_members", data: null },
    ]);
    expect(await canUseWorkflowInWorkspace(fake.db, "wf", "u", null, "firm")).toBe(false);
    expect(fake.calls[1].filters).toContainEqual(["is", "organizations.deleted_at", null]);
    fake.done();
  });

  it("refuses archived workflows", async () => {
    const fake = scriptedDb([{ table: "workflows", data: { ...owned, archived_at: "2026-10-01" } }]);
    expect(await canUseWorkflowInWorkspace(fake.db, "wf", "u", null, "personal")).toBe(false);
    fake.done();
  });

  it("pages full records through the access-aware RPC and filters revoked access", async () => {
    const full = { ...owned, prompt_md: "Instructions", columns_config: [{ name: "Clause" }] };
    const fake = scriptedDb([
      { rpc: "get_workflows_overview", data: [full, { id: "revoked" }] },
      { table: "workflows", data: owned },
      { table: "workflows", data: null },
      { rpc: "get_workflows_overview", data: [] },
    ]);
    expect(await listWorkspaceWorkflows(fake.db, { userId: "u", workspace: "personal" })).toEqual([full]);
    expect(fake.calls[0].args).toMatchObject({ p_workspace: "personal", p_offset: 0 });
    expect(fake.calls[3].args).toMatchObject({ p_workspace: "personal", p_offset: 2 });
    fake.done();
  });

  it("fails closed when the catalog query fails", async () => {
    const fake = scriptedDb([{ rpc: "get_workflows_overview", error: { message: "offline" } }]);
    await expect(listWorkspaceWorkflows(fake.db, { userId: "u", workspace: "firm" })).rejects.toThrow();
  });
});
