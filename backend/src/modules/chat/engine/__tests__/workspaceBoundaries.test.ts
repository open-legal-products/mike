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
const connectors = vi.hoisted(() => {
  const result = { content: "{}", event: { type: "mcp_tool_call", connector_id: "", connector_name: "", tool_name: "", openai_tool_name: "", status: "ok" } };
  const family = () => ({ plan: vi.fn(async () => ({ type: "run" })), execute: vi.fn(async () => result) });
  return { mcp: family(), drive: family(), google: family() };
});
vi.mock("../../../../lib/mcpConnectors", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../lib/mcpConnectors")>(),
  planMcpToolCall: connectors.mcp.plan,
  executeMcpToolCall: connectors.mcp.execute,
}));
vi.mock("../../../../lib/integrations/googleDrive", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../lib/integrations/googleDrive")>(),
  planGoogleDriveCall: connectors.drive.plan,
  executeGoogleDriveToolCall: connectors.drive.execute,
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async importOriginal => ({
  ...await importOriginal<typeof import("../../../../lib/integrations/googleWorkspace")>(),
  planGoogleWorkspaceCall: connectors.google.plan,
  executeGoogleWorkspaceToolCall: connectors.google.execute,
}));
import { buildWorkflowStore } from "../contextBuilders";
import { runToolCalls } from "../tools/toolDispatcher";
import { catalogWorkflowId } from "../../../../lib/workflowCatalog";
import type { WorkflowStore } from "../types";

beforeEach(() => vi.clearAllMocks());

describe("assistant workspace boundaries", () => {
  it("loads only current authorized workflows and their assets, with global built-ins exempt", async () => {
    const fake = scriptedDb([
      { table: "organizations", data: { kind: "team" } },
      { table: "mike_workflows", data: [{ workflow_key: "global", title: "Built-in", prompt_md: "Global" }] },
      // The catalog itself applies current authorization. The loader only
      // normalizes workspace placement; execution still rechecks below.
      { rpc: "get_workflows_overview", data: [{ id: "allowed", org_id: "firm", title: "Here", prompt_md: "Local" }] },
      { table: "organizations", data: [{ id: "firm", kind: "team" }] },
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

  it.each([
    ["mcp_secret_search", "mcp"],
    ["google_drive_search", "drive"],
    ["gmail_search", "google"],
  ] as const)("runs %s on the person's connections for the conversation's organization", async (name, family) => {
    const fake = scriptedDb([{ table: "organizations", data: { kind: "team" } }]);
    await runToolCalls([{ id: "call", function: { name, arguments: "{}" } }], new Map(), "u", fake.db, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { orgId: "firm" });
    const owner = { userId: "u", orgId: "firm" };
    expect(connectors[family].plan).toHaveBeenCalledWith(owner, name, {}, fake.db);
    expect(connectors[family].execute).toHaveBeenCalledWith(owner, name, {}, fake.db);
    fake.done();
  });

  it("runs connector tools on Personal connections in a person's own organization", async () => {
    const fake = scriptedDb([{ table: "organizations", data: { kind: "personal" } }]);
    await runToolCalls([{ id: "call", function: { name: "mcp_search", arguments: "{}" } }], new Map(), "u", fake.db, vi.fn(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { orgId: "mine" });
    expect(connectors.mcp.execute).toHaveBeenCalledWith({ userId: "u", orgId: null }, "mcp_search", {}, fake.db);
    fake.done();
  });
});
