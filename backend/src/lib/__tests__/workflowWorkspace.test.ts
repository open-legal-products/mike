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

  it("uses the access-aware RPC verdict without N individual workflow reads", async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ ...owned, id: `wf-${i}`, prompt_md: "Instructions" }));
    const fake = scriptedDb([
      { rpc: "get_workflows_overview", data: full },
      { rpc: "get_workflows_overview", data: [] },
    ]);
    expect(await listWorkspaceWorkflows(fake.db, { userId: "u", workspace: "personal" })).toEqual(full);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1].args).toMatchObject({ p_workspace: "personal", p_offset: 200 });
    fake.done();
  });

  it("normalizes personal organisation placement once per distinct organisation", async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ ...owned, id: `wf-${i}`, org_id: "personal-org" }));
    const fake = scriptedDb([
      { rpc: "get_workflows_overview", data: full },
      { table: "organizations", data: [{ id: "personal-org", kind: "personal" }] },
      { rpc: "get_workflows_overview", data: [] },
    ]);
    expect(await listWorkspaceWorkflows(fake.db, { userId: "u", workspace: "personal" })).toEqual(full);
    expect(fake.calls[1].filters).toContainEqual(["in", "id", ["personal-org"]]);
    fake.done();
  });

  it("does not mix workspace placement even if a catalog response contains other rows", async () => {
    const fake = scriptedDb([
      { rpc: "get_workflows_overview", data: [owned, { ...owned, id: "team-wf", org_id: "firm" }] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
      { rpc: "get_workflows_overview", data: [] },
    ]);
    expect(await listWorkspaceWorkflows(fake.db, { userId: "u", workspace: "firm" })).toEqual([{ ...owned, id: "team-wf", org_id: "firm" }]);
    fake.done();
  });

  it("fails closed when the catalog query fails", async () => {
    const fake = scriptedDb([{ rpc: "get_workflows_overview", error: { message: "offline" } }]);
    await expect(listWorkspaceWorkflows(fake.db, { userId: "u", workspace: "firm" })).rejects.toThrow();
  });
});
