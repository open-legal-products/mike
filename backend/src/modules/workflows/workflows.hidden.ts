// workflows hidden — implementation behind the module facade.
import { type Db } from "../../lib/supabase";
import { ServiceFailure } from "./workflows.types";

export async function listHiddenWorkflows(
  db: Db,
  userId: string,
): Promise<{ ok: true; ids: unknown[] } | ServiceFailure> {
  const { data, error } = await db
    .from("hidden_workflows")
    .select("workflow_id")
    .eq("user_id", userId);
  if (error) return { ok: false, error };
  return { ok: true, ids: (data ?? []).map((r) => r.workflow_id) };
}

export async function hideWorkflow(
  db: Db,
  userId: string,
  workflowId: string,
): Promise<{ ok: true } | ServiceFailure> {
  const { error } = await db
    .from("hidden_workflows")
    .upsert(
      { user_id: userId, workflow_id: workflowId },
      { onConflict: "user_id,workflow_id" },
    );
  if (error) return { ok: false, error };
  return { ok: true };
}

export async function unhideWorkflow(
  db: Db,
  userId: string,
  workflowId: string,
): Promise<{ ok: true } | ServiceFailure> {
  const { error } = await db
    .from("hidden_workflows")
    .delete()
    .eq("user_id", userId)
    .eq("workflow_id", workflowId);
  if (error) return { ok: false, error };
  return { ok: true };
}
