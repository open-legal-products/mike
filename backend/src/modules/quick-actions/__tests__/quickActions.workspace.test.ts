import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
vi.mock("../../../lib/workflowCatalog", () => ({ ensureDefaultWorkflows: vi.fn(async () => {}) }));
vi.mock("../../../lib/access", () => ({ checkWorkflowAccess: vi.fn(async () => ({ ok: true })) }));
import { listQuickActions } from "../quickActions.service";

describe("quick action workspace", () => {
  it.each(["app", "word"])("filters %s prompts through their workflow's workspace", async surface => {
    const fake = scriptedDb([
      { table: "quick_actions", data: [{ id: "personal-action", workflow_id: "personal" }, { id: "firm-action", workflow_id: "firm", prompt: "Confidential" }] },
      { table: "workflows", data: [{ id: "personal", type: "assistant", title: "Personal", org_id: null }, { id: "firm", type: "assistant", title: "Secret", org_id: "org" }] },
      { table: "organizations", data: { kind: "team" } },
    ]);
    const result = await listQuickActions(fake.db, { userId: "u", userEmail: "u@example.com", surface, workspace: "personal" });
    expect(result).toMatchObject({ ok: true, data: [{ id: "personal-action" }] });
    expect(JSON.stringify(result)).not.toContain("Confidential");
    expect(fake.calls[0].filters).toContainEqual(["eq", "user_id", "u"]);
    fake.done();
  });

  it("never exposes organization actions on the Word surface even if requested", async () => {
    const fake = scriptedDb([
      { table: "quick_actions", data: [{ id: "firm-action", workflow_id: "firm" }] },
      { table: "workflows", data: [{ id: "firm", type: "assistant", org_id: "org" }] },
      { table: "organizations", data: { kind: "team" } },
    ]);
    expect(await listQuickActions(fake.db, { userId: "u", userEmail: undefined, surface: "word", workspace: "org" })).toMatchObject({ ok: true, data: [] });
    fake.done();
  });
});
