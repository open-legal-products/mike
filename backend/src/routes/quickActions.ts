import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../middleware/asyncRoute";
import { createServerSupabase } from "../lib/supabase";
import { ensureDefaultWorkflows } from "../lib/workflowCatalog";
import { sendInternalError } from "../lib/httpError";
import { resolveWorkflowAccess } from "../modules/workflows/workflows.service";

export const quickActionsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
type QuickActionRow = {
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

type QuickActionSurface = "app" | "word";

function isQuickActionSurface(value: unknown): value is QuickActionSurface {
  return value === "app" || value === "word";
}

type LinkedWorkflow = {
  id: string;
  user_id: string | null;
  title: string;
  type: string;
};

// Ownership and share rules live in the workflows service; quick actions only
// add the constraint that the target must be an assistant workflow. `ok:false`
// means the lookup itself failed, which must not be reported as "not found".
type WorkflowAccessLookup =
  | { ok: true; workflow: LinkedWorkflow | null }
  | { ok: false };

async function findLinkableWorkflow(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccessLookup> {
  try {
    const access = await resolveWorkflowAccess(
      db,
      workflowId,
      userId,
      userEmail,
    );
    if (!access || access.workflow.type !== "assistant") {
      return { ok: true, workflow: null };
    }
    const { id, user_id, title } = access.workflow;
    return {
      ok: true,
      workflow: { id, user_id, title: title ?? "", type: "assistant" },
    };
  } catch (error) {
    console.error("[quick-actions] failed to resolve workflow access", error);
    return { ok: false };
  }
}

async function withWorkflowDetails(
  rows: QuickActionRow[],
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
) {
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
    .filter(
      (
        row,
      ): row is QuickActionRow & {
        workflow: { id: string; title: string };
      } =>
        !!row,
    );
}

// quick_actions.sort_order is a Postgres integer; out-of-range values
// would surface as a 500 from the insert instead of a validation error.
const MAX_SORT_ORDER = 2147483647;

function isValidSortOrder(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_SORT_ORDER
  );
}

quickActionsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const surface = req.query.surface ?? "app";
    if (!isQuickActionSurface(surface)) {
      return void res.status(400).json({
        detail: "surface must be either 'app' or 'word'",
      });
    }
    const db = createServerSupabase();
    await ensureDefaultWorkflows(userId, db);
    const { data, error } = await db
      .from("quick_actions")
      .select("*")
      .eq("user_id", userId)
      .eq("surface", surface)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) return void sendInternalError(res, error);
    res.json(
      await withWorkflowDetails(
        (data ?? []) as QuickActionRow[],
        userId,
        userEmail,
        db,
      ),
    );
  }),
);

quickActionsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const workflowId =
      typeof req.body?.workflow_id === "string"
        ? req.body.workflow_id.trim()
        : "";
    if (!workflowId) {
      return void res.status(400).json({ detail: "workflow_id is required" });
    }
    const surface = req.body?.surface ?? "app";
    if (!isQuickActionSurface(surface)) {
      return void res.status(400).json({
        detail: "surface must be either 'app' or 'word'",
      });
    }
    // Reject any supplied sort_order that isn't a valid integer. Gating this
    // on Number.isInteger first would let "3", 1.5 and NaN through to be
    // silently coerced to 0 below.
    const sortOrder = req.body?.sort_order;
    if (sortOrder !== undefined && !isValidSortOrder(sortOrder)) {
      return void res.status(400).json({
        detail: `sort_order must be between 0 and ${MAX_SORT_ORDER}`,
      });
    }
    const db = createServerSupabase();
    const access = await findLinkableWorkflow(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access.ok) {
      return void res
        .status(500)
        .json({ detail: "Failed to look up workflow" });
    }
    const workflow = access.workflow;
    if (!workflow) {
      return void res.status(404).json({ detail: "Workflow not found" });
    }
    const { data, error } = await db
      .from("quick_actions")
      .insert({
        user_id: userId,
        workflow_id: workflowId,
        name:
          typeof req.body?.name === "string" && req.body.name.trim()
            ? req.body.name.trim()
            : workflow.title,
        prompt: typeof req.body?.prompt === "string" ? req.body.prompt : "",
        document_upload: req.body?.document_upload === true,
        surface,
        enabled: req.body?.enabled !== false,
        sort_order: sortOrder === undefined ? 0 : sortOrder,
      })
      .select("*")
      .single();
    if (error || !data) {
      return void sendInternalError(
        res,
        error ?? new Error("Quick action create returned no data"),
      );
    }
    res.status(201).json({ ...data, workflow });
  }),
);

quickActionsRouter.patch(
  "/:quickActionId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { quickActionId } = req.params;
    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (typeof req.body?.name === "string") {
      const name = req.body.name.trim();
      if (!name) {
        return void res.status(400).json({ detail: "name cannot be empty" });
      }
      updates.name = name;
    }
    if (typeof req.body?.prompt === "string") updates.prompt = req.body.prompt;
    if (typeof req.body?.document_upload === "boolean") {
      updates.document_upload = req.body.document_upload;
    }
    if (req.body?.surface !== undefined) {
      if (!isQuickActionSurface(req.body.surface)) {
        return void res.status(400).json({
          detail: "surface must be either 'app' or 'word'",
        });
      }
      updates.surface = req.body.surface;
    }
    if (typeof req.body?.enabled === "boolean")
      updates.enabled = req.body.enabled;
    // Same as the create path: validate whatever was supplied rather than only
    // the values that already look like integers.
    const sortOrder = req.body?.sort_order;
    if (sortOrder !== undefined) {
      if (!isValidSortOrder(sortOrder)) {
        return void res.status(400).json({
          detail: `sort_order must be between 0 and ${MAX_SORT_ORDER}`,
        });
      }
      updates.sort_order = sortOrder;
    }

    const db = createServerSupabase();
    if (typeof req.body?.workflow_id === "string") {
      const workflowId = req.body.workflow_id.trim();
      if (!workflowId) {
        return void res.status(400).json({ detail: "workflow_id is required" });
      }
      const access = await findLinkableWorkflow(
        workflowId,
        userId,
        userEmail,
        db,
      );
      if (!access.ok) {
        return void res
          .status(500)
          .json({ detail: "Failed to look up workflow" });
      }
      if (!access.workflow) {
        return void res.status(404).json({ detail: "Workflow not found" });
      }
      updates.workflow_id = workflowId;
    }
    const { data, error } = await db
      .from("quick_actions")
      .update(updates)
      .eq("id", quickActionId)
      .eq("user_id", userId)
      .select("*")
      .maybeSingle();
    if (error || !data) {
      return void res.status(404).json({ detail: "Quick action not found" });
    }
    const [result] = await withWorkflowDetails(
      [data as QuickActionRow],
      userId,
      userEmail,
      db,
    );
    if (!result) {
      // The quick action row updated, but its workflow is no longer
      // accessible (e.g. the share was revoked), so it is hidden from
      // the list and reported the same way here.
      return void res.status(404).json({ detail: "Quick action not found" });
    }
    res.json(result);
  }),
);

quickActionsRouter.delete(
  "/:quickActionId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    // Selecting the deleted rows separates "gone now" from "was never yours":
    // without it a bad id (or another user's) also answered 204.
    const { data, error } = await db
      .from("quick_actions")
      .delete()
      .eq("id", req.params.quickActionId)
      .eq("user_id", userId)
      .select("id");
    if (error) return void sendInternalError(res, error);
    if (!data?.length) {
      return void res.status(404).json({ detail: "Quick action not found" });
    }
    res.status(204).send();
  }),
);

quickActionsRouter.use(
  routerErrorHandler("[quick-actions]"),
);
