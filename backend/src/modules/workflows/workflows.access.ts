// workflows access — implementation behind the module facade.
import { type Db } from "../../lib/supabase";
import { checkWorkflowAccess } from "../../lib/access";
import { can } from "../../lib/permissions";
import { WorkflowAccess, WorkflowRecord } from "./workflows.types";
import { workflowTypeFrom } from "./workflows.serialization";

export function assetsUnsupported(access: NonNullable<WorkflowAccess>) {
  return workflowTypeFrom(access.workflow.type) !== "assistant";
}

export async function resolveWorkflowAccess(
  db: Db,
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const verdict = await checkWorkflowAccess(workflowId, userId, userEmail, db);
  if (!verdict.ok) return null;
  return {
    workflow: workflow as WorkflowRecord,
    role: verdict.projectRole,
    allowEdit: can(verdict.projectRole, "content.edit"),
    isOwner: can(verdict.projectRole, "access.manage"),
  };
}

// Owner-scoped workflow operations use the same effective resource role as
// the rest of the application. The creator is always an Owner, an org Admin
// defaults to Owner, and explicit organization overrides may assign another
// member Owner access.
export async function resolveCreatorScopedWorkflow(
  db: Db,
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
): Promise<WorkflowRecord | null> {
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  return access?.isOwner ? access.workflow : null;
}
