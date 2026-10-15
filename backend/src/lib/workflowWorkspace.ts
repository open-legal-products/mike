import { checkWorkflowAccess } from "./access";
import { teamOrgIdOf } from "./personalOrgs";
import type { Db } from "./supabase";
import { PERSONAL_WORKSPACE, workspaceMatches } from "./workspace";

/** Authorization and placement are independent requirements. */
export async function canUseWorkflowInWorkspace(
  db: Db,
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  workspace: string,
): Promise<boolean> {
  const access = await checkWorkflowAccess(workflowId, userId, userEmail, db);
  return (
    access.ok &&
    workspaceMatches(workspace, await teamOrgIdOf(db, access.workflow.org_id))
  );
}

/** Full records for execution and pickers, using the ordinary access-aware RPC. */
export async function listWorkspaceWorkflows<T extends { id: string }>(
  db: Db,
  args: {
    userId: string;
    userEmail?: string | null;
    type?: string | null;
    workspace: string;
  },
): Promise<T[]> {
  const rows: T[] = [];
  // Continue until empty, since PostgREST may cap a page below our requested size.
  for (let offset = 0; ; ) {
    const { data, error } = await db.rpc("get_workflows_overview", {
      p_user_id: args.userId,
      p_user_email: args.userEmail?.trim().toLowerCase() || null,
      p_type: args.type ?? null,
      p_scope: "all",
      p_limit: 1000,
      p_offset: offset,
      p_search_term: null,
      p_sort_key: "created",
      p_sort_direction: "desc",
      p_practice: null,
      p_language: null,
      p_jurisdiction: null,
      p_workspace: args.workspace || PERSONAL_WORKSPACE,
    });
    if (error) throw new Error("Failed to load workspace workflows");
    const page = (data ?? []) as T[];
    if (!page.length) return rows;
    for (const row of page) {
      if (await canUseWorkflowInWorkspace(
        db, row.id, args.userId, args.userEmail, args.workspace,
      )) {
        rows.push(row);
      }
    }
    offset += page.length;
  }
}
