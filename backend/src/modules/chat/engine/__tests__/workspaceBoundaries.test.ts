import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../../__tests__/helpers/scriptedDb";

vi.mock("../../../../lib/workflowCatalog", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../lib/workflowCatalog")>(),
  ensureDefaultWorkflows: vi.fn(async () => {}),
}));
vi.mock("../../../../lib/documentVersions", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../lib/documentVersions")>(),
  attachActiveVersionPaths: vi.fn(async () => {}),
}));
import { buildWorkflowStore } from "../contextBuilders";
import { runToolCalls } from "../tools/toolDispatcher";
import { runApprovedConnectorActions } from "../tools/connectorApprovals";
import { catalogWorkflowId } from "../../../../lib/workflowCatalog";
import type { WorkflowStore } from "../types";

beforeEach(() => vi.clearAllMocks());

describe("assistant workspace boundaries", () => {
  it("loads only current authorized workflows and their assets, with global built-ins exempt", async () => {
    const fake = scriptedDb([
      { table: "organizations", data: { kind: "team" } },
      { table: "mike_workflows", data: [{ workflow_key: "global", title: "Built-in", prompt_md: "Global" }] },
      { rpc: "get_workflows_overview", data: [{ id: "allowed", title: "Here", prompt_md: "Local" }, { id: "denied", prompt_md: "Secret" }] },
      { table: "workflows", data: { id: "allowed", org_id: "firm", user_id: "u" } },
      { table: "org_members", data: { role: "member" } },
      { table: "organizations", data: { kind: "team" } },
      { table: "workflows", data: { id: "denied", org_id: "deleted", user_id: "u" } },
      { table: "org_members", data: null },
      { rpc: "get_workflows_overview", data: [] },
      { table: "documents", data: [] },
    ]);
    const store = await buildWorkflowStore("u", "u@example.com", fake.db, "firm");
    expect([...store.keys()]).toEqual([catalogWorkflowId("global"), "allowed"]);
    expect(fake.calls[2].args).toMatchObject({ p_workspace: "firm" });
    expect(fake.calls.at(-1)?.filters).toContainEqual(["in", "workflow_id", ["allowed"]]);
    fake.done();
  });

  it("rechecks read_workflow before exposing cached instructions or assets", async () => {
    const workflows: WorkflowStore = new Map([["wf", { title: "Secret", skill_md: "Confidential instructions", assets: [{ asset_id: "doc", filename: "Secret.docx", file_type: "docx", storage_path: "secret" }] }]]);
    const fake = scriptedDb([{ table: "workflows", data: null }]);
    const docs = new Map();
    const result = await runToolCalls([{ id: "call", function: { name: "read_workflow", arguments: '{"workflow_id":"wf"}' } }], docs, "u", fake.db, vi.fn(), workflows);
    expect(JSON.stringify(result.toolResults)).not.toContain("Confidential");
    expect(result.workflowsApplied).toEqual([]);
    expect(docs.size).toBe(0);
    fake.done();
  });

  it.each(["mcp_secret_search", "google_drive_search", "gmail_search"])("refuses unadvertised connector tool %s before credential lookup", async name => {
    const fake = scriptedDb([{ table: "organizations", data: { kind: "team" } }]);
    const result = await runToolCalls([{ id: "call", function: { name, arguments: "{}" } }], new Map(), "u", fake.db, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { orgId: "firm" });
    expect(JSON.stringify(result.toolResults)).toContain("Personal workspace");
    fake.done();
  });

  it("does not resume a connector write approval in an organization", async () => {
    const fake = scriptedDb([{ table: "organizations", data: { kind: "team" } }]);
    expect(await runApprovedConnectorActions({ db: fake.db, chatId: "chat", messageId: "message", askEventId: "ask", userId: "u", orgId: "firm" })).toEqual([]);
    fake.done();
  });
});
