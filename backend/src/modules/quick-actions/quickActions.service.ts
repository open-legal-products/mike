// Business logic + data-access for the quick-actions module.
//
// Service layer behind quickActions.routes.ts. Every function takes an
// explicit Supabase client (`db`) plus request-derived primitives, validates
// the caller's payload, enforces the workflow-access boundary, and RETURNS a
// `ServiceResult`. It never touches req/res.
//
// One deliberate exception to the result contract: the workflow-hydration
// queries THROW on a database error rather than returning a failure. The
// route's error middleware turns that into the opaque internal-error body, so
// the throw is load-bearing and is kept.

import type { Db } from "../../lib/supabase";
import { ensureDefaultWorkflows } from "../../lib/workflowCatalog";
import { checkWorkflowAccess } from "../../lib/access";
import {
  failure,
  internalFailure,
  ok,
  type ServiceResult,
} from "../../lib/serviceResult";

export type QuickActionSurface = "app" | "word";

export type QuickActionRow = {
  id: string;
  user_id: string;
  workflow_id: string;
  name: string;
  prompt: string;
  document_upload: boolean;
  surface: QuickActionSurface;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type WorkflowRow = {
  id: string;
  user_id: string;
  title: string;
  type: string;
};

export type QuickActionWithWorkflow = QuickActionRow & {
  workflow: { id: string; title: string };
};

export function isQuickActionSurface(
  value: unknown,
): value is QuickActionSurface {
  return value === "app" || value === "word";
}

// quick_actions.sort_order is a Postgres integer; out-of-range values
// would surface as a 500 from the insert instead of a validation error.
export const MAX_SORT_ORDER = 2147483647;

export function isValidSortOrder(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_SORT_ORDER
  );
}

const SURFACE_DETAIL = "surface must be either 'app' or 'word'";
const SORT_ORDER_DETAIL = `sort_order must be between 0 and ${MAX_SORT_ORDER}`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

// Ownership and share rules live in lib/access; quick actions only add the
// constraint that the target must be an assistant workflow. `ok:false` means
// the lookup ITSELF failed, which must not be reported as "not found": a
// database blip told the caller their workflow was gone and to stop retrying.
type WorkflowLookup =
  | { ok: true; workflow: WorkflowRow | null }
  | { ok: false; error: unknown };

async function canAccessWorkflow(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowLookup> {
  const { data: workflow, error } = await db
    .from("workflows")
    .select("id, user_id, title, type")
    .eq("id", workflowId)
    .maybeSingle();
  if (error) return { ok: false, error };
  if (!workflow || workflow.type !== "assistant") {
    return { ok: true, workflow: null };
  }
  const access = await checkWorkflowAccess(workflowId, userId, userEmail, db);
  return { ok: true, workflow: access.ok ? workflow : null };
}

async function withWorkflowDetails(
  rows: QuickActionRow[],
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<QuickActionWithWorkflow[]> {
  const ids = [...new Set(rows.map((row) => row.workflow_id))];
  if (ids.length === 0) return [];
  const { data: workflows, error } = await db
    .from("workflows")
    .select("id, user_id, title, type")
    .in("id", ids);
  if (error) throw error;

  const accessVerdicts = await Promise.all(
    (workflows ?? []).map((workflow) =>
      checkWorkflowAccess(workflow.id, userId, userEmail, db),
    ),
  );
  const accessibleIds = new Set(
    (workflows ?? [])
      .filter((_workflow, index) => accessVerdicts[index]?.ok)
      .map((workflow) => workflow.id),
  );
  const byId = new Map(
    (workflows ?? [])
      .filter(
        (workflow) =>
          workflow.type === "assistant" && accessibleIds.has(workflow.id),
      )
      .map((workflow) => [
        workflow.id,
        {
          id: workflow.id,
          title: workflow.title,
        },
      ]),
  );
  return rows
    .map((row) => {
      const workflow = byId.get(row.workflow_id);
      return workflow ? { ...row, workflow } : null;
    })
    .filter((row): row is QuickActionWithWorkflow => !!row);
}

/** The caller's quick actions for one surface, hydrated with their workflow. */
export async function listQuickActions(
  db: Db,
  args: { userId: string; userEmail: string | undefined; surface: unknown },
): Promise<ServiceResult<QuickActionWithWorkflow[]>> {
  const surface = args.surface ?? "app";
  if (!isQuickActionSurface(surface)) {
    return failure("validation", SURFACE_DETAIL);
  }
  await ensureDefaultWorkflows(args.userId, db);
  const { data, error } = await db
    .from("quick_actions")
    .select("*")
    .eq("user_id", args.userId)
    .eq("surface", surface)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return internalFailure(error);
  return ok(
    await withWorkflowDetails(
      (data ?? []) as QuickActionRow[],
      args.userId,
      args.userEmail,
      db,
    ),
  );
}

/**
 * Create a quick action pointing at a workflow the caller can reach. The
 * created row carries the full workflow row it was validated against, which
 * is what the endpoint has always echoed back.
 */
export async function createQuickAction(
  db: Db,
  args: { userId: string; userEmail: string | undefined; body: unknown },
): Promise<ServiceResult<QuickActionRow & { workflow: WorkflowRow }>> {
  const body = asRecord(args.body);
  const workflowId =
    typeof body.workflow_id === "string" ? body.workflow_id.trim() : "";
  if (!workflowId) {
    return failure("validation", "workflow_id is required");
  }
  const surface = body.surface ?? "app";
  if (!isQuickActionSurface(surface)) {
    return failure("validation", SURFACE_DETAIL);
  }
  // Reject any supplied sort_order that is not a valid integer. Gating this on
  // Number.isInteger first let "3", 1.5 and NaN through to be silently coerced
  // to 0 below.
  const sortOrder = body.sort_order;
  if (sortOrder !== undefined && !isValidSortOrder(sortOrder)) {
    return failure("validation", SORT_ORDER_DETAIL);
  }
  const lookup = await canAccessWorkflow(
    workflowId,
    args.userId,
    args.userEmail,
    db,
  );
  if (!lookup.ok) return internalFailure(lookup.error);
  const workflow = lookup.workflow;
  if (!workflow) return failure("not_found", "Workflow not found");
  const { data, error } = await db
    .from("quick_actions")
    .insert({
      user_id: args.userId,
      workflow_id: workflowId,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : workflow.title,
      prompt: typeof body.prompt === "string" ? body.prompt : "",
      document_upload: body.document_upload === true,
      surface,
      enabled: body.enabled !== false,
      sort_order: sortOrder === undefined ? 0 : sortOrder,
    })
    .select("*")
    .single();
  if (error || !data) {
    return internalFailure(
      error ?? new Error("Quick action create returned no data"),
    );
  }
  return ok({ ...(data as QuickActionRow), workflow });
}

/** Patch one of the caller's quick actions. */
export async function updateQuickAction(
  db: Db,
  args: {
    userId: string;
    userEmail: string | undefined;
    quickActionId: string;
    body: unknown;
  },
): Promise<ServiceResult<QuickActionWithWorkflow>> {
  const body = asRecord(args.body);
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (typeof body.name === "string") {
    const name = body.name.trim();
    if (!name) return failure("validation", "name cannot be empty");
    updates.name = name;
  }
  if (typeof body.prompt === "string") updates.prompt = body.prompt;
  if (typeof body.document_upload === "boolean") {
    updates.document_upload = body.document_upload;
  }
  if (body.surface !== undefined) {
    if (!isQuickActionSurface(body.surface)) {
      return failure("validation", SURFACE_DETAIL);
    }
    updates.surface = body.surface;
  }
  if (typeof body.enabled === "boolean") updates.enabled = body.enabled;
  // Same as the create path: validate whatever was supplied rather than only
  // the values that already look like integers.
  const sortOrder = body.sort_order;
  if (sortOrder !== undefined) {
    if (!isValidSortOrder(sortOrder)) {
      return failure("validation", SORT_ORDER_DETAIL);
    }
    updates.sort_order = sortOrder;
  }

  if (typeof body.workflow_id === "string") {
    const workflowId = body.workflow_id.trim();
    if (!workflowId) return failure("validation", "workflow_id is required");
    const lookup = await canAccessWorkflow(
      workflowId,
      args.userId,
      args.userEmail,
      db,
    );
    if (!lookup.ok) return internalFailure(lookup.error);
    if (!lookup.workflow) return failure("not_found", "Workflow not found");
    updates.workflow_id = workflowId;
  }
  const { data, error } = await db
    .from("quick_actions")
    .update(updates)
    .eq("id", args.quickActionId)
    .eq("user_id", args.userId)
    .select("*")
    .maybeSingle();
  if (error || !data) return failure("not_found", "Quick action not found");
  const [result] = await withWorkflowDetails(
    [data as QuickActionRow],
    args.userId,
    args.userEmail,
    db,
  );
  if (!result) {
    // The quick action row updated, but its workflow is no longer
    // accessible (e.g. the share was revoked), so it is hidden from
    // the list and reported the same way here.
    return failure("not_found", "Quick action not found");
  }
  return ok(result);
}

/** Delete one of the caller's quick actions. */
export async function deleteQuickAction(
  db: Db,
  args: { userId: string; quickActionId: string },
): Promise<ServiceResult<void>> {
  // Selecting the deleted rows separates "gone now" from "was never yours":
  // without it a bad id (or another user's) also answered 204.
  const { data, error } = await db
    .from("quick_actions")
    .delete()
    .eq("id", args.quickActionId)
    .eq("user_id", args.userId)
    .select("id");
  if (error) return internalFailure(error);
  if (!data?.length) return failure("not_found", "Quick action not found");
  return ok(undefined);
}
