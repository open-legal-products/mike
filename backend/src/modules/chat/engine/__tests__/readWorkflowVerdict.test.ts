import { expect, it, vi } from "vitest";

const canUse = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../../../lib/workflowWorkspace", async (original) => ({
  ...(await original<typeof import("../../../../lib/workflowWorkspace")>()),
  canUseWorkflowInWorkspace: canUse,
}));
import { runToolCalls } from "../tools/toolDispatcher";
import type { WorkflowStore } from "../types";

it("checks read_workflow access once per workflow per turn", async () => {
  const store: WorkflowStore = new Map([["wf", { title: "Guide", skill_md: "Steps" }]]);
  const read = (id: string) => ({ id, function: { name: "read_workflow", arguments: '{"workflow_id":"wf"}' } });
  const db = { from: () => { throw new Error("no query expected"); } } as never;

  const first = await runToolCalls([read("a"), read("b")], new Map(), "u", db, vi.fn(), store);
  await runToolCalls([read("c")], new Map(), "u", db, vi.fn(), store);

  expect(first.workflowsApplied).toHaveLength(2);
  expect(canUse).toHaveBeenCalledTimes(1);
});
