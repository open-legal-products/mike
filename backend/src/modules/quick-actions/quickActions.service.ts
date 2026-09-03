// Business logic + data-access for the quick-actions module.
//
// Service layer behind quickActions.routes.ts. Every function takes an
// explicit Supabase client (`db`) plus request-derived primitives, validates
// the caller's payload, enforces the workflow-access boundary, and RETURNS a
// `ServiceResult`. It never touches req/res.
//
// One deliberate exception to the result contract: the workflow-hydration
// queries THROW on a database error rather than returning a failure. That is
// the behavior the route's error middleware has always rendered ("Failed to
// process quick action request"), so the throw is load-bearing and is kept.

import type { Db } from "../../lib/supabase";
import { ensureDefaultWorkflows } from "../../lib/workflowCatalog";
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

async function canAccessWorkflow(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowRow | null> {
  const { data: workflow } = await db
    .from("workflows")
    .select("id, user_id, title, type")
    .eq("id", workflowId)
    .maybeSingle();
  if (!workflow || workflow.type !== "assistant") return null;
  if (workflow.user_id === userId) return workflow;
  const email = (userEmail ?? "").trim().toLowerCase();
  if (!email) return null;
  const { data: share } = await db
    .from("workflow_shares")
    .select("id")
    .eq("workflow_id", workflowId)
    .eq("shared_with_email", email)
    .maybeSingle();
  return share ? workflow : null;
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

  // A quick action may point at a workflow someone shared and has since
  // revoked; only keep workflows the user owns or still has a share for,
  // and drop quick actions whose workflow is no longer accessible.
  const email = (userEmail ?? "").trim().toLowerCase();
  const foreignIds = (workflows ?? [])
    .filter((workflow) => workflow.user_id !== userId)
    .map((workflow) => workflow.id);
  const sharedIds = new Set<string>();
  if (email && foreignIds.length > 0) {
    const { data: shares, error: sharesError } = await db
      .from("workflow_shares")
      .select("workflow_id")
      .in("workflow_id", foreignIds)
      .eq("shared_with_email", email);
    if (sharesError) throw sharesError;
    for (const share of shares ?? []) sharedIds.add(share.workflow_id);
  }
  const byId = new Map(
    (workflows ?? [])
      .filter(
        (workflow) =>
          workflow.type === "assistant" &&
          (workflow.user_id === userId || sharedIds.has(workflow.id)),
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
  if (
    body.sort_order !== undefined &&
    Number.isInteger(body.sort_order) &&
    !isValidSortOrder(body.sort_order)
  ) {
    return failure("validation", SORT_ORDER_DETAIL);
  }
  const workflow = await canAccessWorkflow(
    workflowId,
    args.userId,
    args.userEmail,
    db,
  );
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
      sort_order: isValidSortOrder(body.sort_order) ? body.sort_order : 0,
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
  if (Number.isInteger(body.sort_order)) {
    if (!isValidSortOrder(body.sort_order)) {
      return failure("validation", SORT_ORDER_DETAIL);
    }
    updates.sort_order = body.sort_order;
  }

  if (typeof body.workflow_id === "string") {
    const workflowId = body.workflow_id.trim();
    if (!workflowId) return failure("validation", "workflow_id is required");
    const workflow = await canAccessWorkflow(
      workflowId,
      args.userId,
      args.userEmail,
      db,
    );
    if (!workflow) return failure("not_found", "Workflow not found");
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
  const { error } = await db
    .from("quick_actions")
    .delete()
    .eq("id", args.quickActionId)
    .eq("user_id", args.userId);
  if (error) return internalFailure(error);
  return ok(undefined);
}
