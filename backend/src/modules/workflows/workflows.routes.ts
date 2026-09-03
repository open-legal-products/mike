// HTTP surface for the workflows module. Handlers parse params/query/body,
// call the service layer in workflows.service.ts, and map its typed results
// onto status codes and JSON responses.

import { Router, type NextFunction, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { parsePaginationQuery } from "../../lib/pagination";
import { normalizeSearchTerm } from "../../lib/search";
import { parseWorkflowSort } from "../../lib/sort";
import { parseWorkflowScope } from "./workflows.overview";
import { sendInternalError } from "../../lib/httpError";
import {
  listWorkflows,
  listWorkflowsPage,
  listSystemWorkflows,
  getWorkflowFilterOptions,
  listWorkflowIds,
  ensureDefaultsInstalled,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  getWorkflowDetail,
  findSystemWorkflow,
  withSystemWorkflowAccess,
  submitOpenSourceWorkflow,
  WORKFLOW_CONTRIBUTIONS_ENABLED,
  listHiddenWorkflows,
  hideWorkflow,
  unhideWorkflow,
  parseAssetDocumentIds,
  listWorkflowAssets,
  copyDocumentsToWorkflowAssets,
  deleteWorkflowAsset,
  listWorkflowShares,
  deleteWorkflowShare,
  shareWorkflow,
  type Db,
  type WorkflowAssetFailure,
  type WorkflowMetadata,
} from "./workflows.service";

export const workflowsRouter = Router();

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

// Installs missing default workflows before any listing; a failure here is
// terminal for the request (500 with the opaque internal-error body).
async function ensureDefaultsForRequest(
  db: Db,
  userId: string,
  res: Response,
): Promise<boolean> {
  const result = await ensureDefaultsInstalled(db, userId);
  if (result.ok) return true;
  sendInternalError(res, result.error);
  return false;
}

// Maps a workflow-asset service failure onto the status code + detail the
// monolith used for that condition.
function sendWorkflowAssetFailure(res: Response, failure: WorkflowAssetFailure) {
  switch (failure.kind) {
    case "workflow_not_found":
      return void res.status(404).json({ detail: "Workflow not found" });
    case "not_editable":
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });
    case "tabular_unsupported":
      return void res.status(400).json({
        detail: "Assets are only available for assistant workflows",
      });
    case "asset_not_found":
      return void res.status(404).json({ detail: "Asset not found" });
    case "documents_not_found":
      return void res
        .status(404)
        .json({ detail: "One or more files could not be found" });
    case "documents_not_ready":
      return void res
        .status(409)
        .json({ detail: "One or more files are not ready" });
    case "db_error":
      return void sendInternalError(res, failure.error);
  }
}

const WORKFLOW_PAGINATION_QUERY_KEYS = [
  "limit",
  "offset",
  "search",
  "sort_key",
  "key",
  "sort_direction",
  "direction",
  "scope",
  "practice",
  "language",
  "jurisdiction",
];

// GET /workflows
workflowsRouter.get("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { type } = req.query as { type?: string };
  const db = createServerSupabase();
  const workflowType = typeof type === "string" && type ? type : null;

  if (!(await ensureDefaultsForRequest(db, userId, res))) return;

  const hasPaginationParams = WORKFLOW_PAGINATION_QUERY_KEYS.some(
    (key) => req.query[key] !== undefined,
  );
  const result = hasPaginationParams
    ? await listWorkflowsPage(db, {
        userId,
        userEmail,
        type: workflowType,
        scope: parseWorkflowScope(req.query.scope),
        pagination: parsePaginationQuery(req.query as Record<string, unknown>),
        searchTerm: normalizeSearchTerm(req.query.search),
        sort: parseWorkflowSort(req.query as Record<string, unknown>),
        practice: normalizeSearchTerm(req.query.practice),
        language: normalizeSearchTerm(req.query.language),
        jurisdiction: normalizeSearchTerm(req.query.jurisdiction),
      })
    : await listWorkflows(db, { userId, userEmail, type: workflowType });
  if (!result.ok) {
    return void sendInternalError(res, result.error);
  }

  res.json(result.data);
}));

// GET /workflows/system
// Retained as a compatibility endpoint for older clients. The restructured
// Workflows page no longer exposes a System tab; non-default catalog entries
// are presented through /workflow-addons instead.
workflowsRouter.get("/system", requireAuth, asyncRoute(async (req, res) => {
  const workflowType =
    req.query.type === "assistant" || req.query.type === "tabular"
      ? req.query.type
      : null;
  const db = createServerSupabase();
  res.json(await listSystemWorkflows(db, workflowType));
}));

// GET /workflows/filter-options (must come before /:workflowId routes)
workflowsRouter.get("/filter-options", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const type =
    req.query.type === "assistant" || req.query.type === "tabular"
      ? req.query.type
      : null;
  const scope = parseWorkflowScope(req.query.scope);
  const db = createServerSupabase();
  if (!(await ensureDefaultsForRequest(db, userId, res))) return;

  const result = await getWorkflowFilterOptions(db, {
    userId,
    userEmail,
    type,
    scope,
  });
  if (!result.ok) return void sendInternalError(res, result.error);
  res.json(result.options);
}));

// GET /workflows/ids (must come before /:workflowId routes)
workflowsRouter.get("/ids", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  if (!(await ensureDefaultsForRequest(db, userId, res))) return;

  const workflowType =
    typeof req.query.type === "string" && req.query.type
      ? req.query.type
      : null;
  const result = await listWorkflowIds(db, {
    userId,
    userEmail,
    type: workflowType,
    scope: parseWorkflowScope(req.query.scope),
    searchTerm: normalizeSearchTerm(req.query.search),
    practice: normalizeSearchTerm(req.query.practice),
    language: normalizeSearchTerm(req.query.language),
    jurisdiction: normalizeSearchTerm(req.query.jurisdiction),
  });
  if (!result.ok) return void sendInternalError(res, result.error);
  res.json(result.ids);
}));

// POST /workflows
workflowsRouter.post("/", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const {
    metadata,
    skill_md,
    columns_config,
  } = req.body as {
    metadata?: Partial<WorkflowMetadata>;
    skill_md?: string;
    columns_config?: unknown;
  };
  const title = metadata?.title;
  const type = metadata?.type;
  if (!title?.trim())
    return void res.status(400).json({ detail: "metadata.title is required" });
  if (type !== "assistant" && type !== "tabular")
    return void res
      .status(400)
      .json({ detail: "metadata.type must be 'assistant' or 'tabular'" });

  const db = createServerSupabase();
  const result = await createWorkflow(db, {
    userId,
    title,
    type,
    skill_md,
    columns_config,
    metadata,
  });
  if (!result.ok) {
    return void sendInternalError(res, result.error);
  }
  res.status(201).json(result.workflow);
}));

async function handleWorkflowUpdate(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerSupabase();

  const result = await updateWorkflow(db, {
    workflowId,
    userId,
    userEmail,
    body: req.body,
  });
  if (!result.ok) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  res.json(result.body);
}

// PUT /workflows/:workflowId
workflowsRouter.put("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// PATCH /workflows/:workflowId
workflowsRouter.patch("/:workflowId", requireAuth, asyncRoute(handleWorkflowUpdate));

// DELETE /workflows/:workflowId
workflowsRouter.delete("/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const systemWorkflow = await findSystemWorkflow(db, workflowId);
  if (systemWorkflow) {
    return void res.json(withSystemWorkflowAccess(systemWorkflow));
  }

  const result = await deleteWorkflow(db, userId, workflowId);
  if (!result.ok) return void sendInternalError(res, result.error);
  res.status(204).send();
}));

// GET /workflows/hidden
workflowsRouter.get("/hidden", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const db = createServerSupabase();
  const result = await listHiddenWorkflows(db, userId);
  if (!result.ok) return void sendInternalError(res, result.error);
  res.json(result.ids);
}));

// POST /workflows/hidden
workflowsRouter.post("/hidden", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflow_id } = req.body as { workflow_id: string };
  if (!workflow_id?.trim())
    return void res.status(400).json({ detail: "workflow_id is required" });
  const db = createServerSupabase();
  const result = await hideWorkflow(db, userId, workflow_id);
  if (!result.ok) return void sendInternalError(res, result.error);
  res.status(204).send();
}));

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete("/hidden/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const result = await unhideWorkflow(db, userId, workflowId);
  if (!result.ok) return void sendInternalError(res, result.error);
  res.status(204).send();
}));

// POST /workflows/:workflowId/open-source
workflowsRouter.post("/:workflowId/open-source", requireAuth, asyncRoute(async (req, res) => {
  if (!WORKFLOW_CONTRIBUTIONS_ENABLED) {
    return void res.status(404).json({ detail: "Workflow contributions are disabled" });
  }

  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const openSourceBody = req.body as {
    contributor_mode?: unknown;
    contributor?: unknown;
  };
  const db = createServerSupabase();

  const result = await submitOpenSourceWorkflow(db, {
    workflowId,
    userId,
    userEmail,
    body: openSourceBody,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not open-sourceable" });
    }
    if (result.kind === "validation") {
      return void res.status(400).json({ detail: result.detail });
    }
    return void sendInternalError(res, result.error);
  }

  res.status(result.status).json(result.body);
}));

// GET /workflows/:workflowId/assets
workflowsRouter.get("/:workflowId/assets", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  const result = await listWorkflowAssets(db, {
    workflowId: req.params.workflowId,
    userId,
    userEmail,
  });
  if (!result.ok) return sendWorkflowAssetFailure(res, result);
  res.json(result.assets);
}));

// POST /workflows/:workflowId/assets/from-documents
workflowsRouter.post(
  "/:workflowId/assets/from-documents",
  requireAuth,
  asyncRoute(async (req, res) => {
    // Body validation runs before any client is created, so a malformed
    // selection never opens a database connection.
    const documentIds = parseAssetDocumentIds(req.body?.document_ids);
    if (!documentIds) {
      return void res.status(400).json({
        detail: "document_ids must contain between 1 and 50 unique file IDs",
      });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await copyDocumentsToWorkflowAssets(db, {
      workflowId: req.params.workflowId,
      userId,
      userEmail,
      documentIds,
    });
    if (!result.ok) return sendWorkflowAssetFailure(res, result);
    res.status(201).json(result.assets);
  }),
);

// DELETE /workflows/:workflowId/assets/:assetId
workflowsRouter.delete(
  "/:workflowId/assets/:assetId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await deleteWorkflowAsset(db, {
      workflowId: req.params.workflowId,
      assetId: req.params.assetId,
      userId,
      userEmail,
    });
    if (!result.ok) return sendWorkflowAssetFailure(res, result);
    res.status(204).send();
  }),
);

// GET /workflows/:workflowId
workflowsRouter.get("/:workflowId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const db = createServerSupabase();
  const systemWorkflow = await findSystemWorkflow(db, workflowId);
  if (systemWorkflow) {
    return void res.json(withSystemWorkflowAccess(systemWorkflow));
  }

  const result = await getWorkflowDetail(db, { workflowId, userId, userEmail });
  if (!result.ok)
    return void res.status(404).json({ detail: "Workflow not found" });
  res.json(result.body);
}));

// GET /workflows/:workflowId/shares
workflowsRouter.get("/:workflowId/shares", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId } = req.params;
  const db = createServerSupabase();

  const result = await listWorkflowShares(db, { workflowId, userId });
  if (!result.ok) {
    if (result.kind === "not_found")
      return void res.status(404).json({ detail: "Workflow not found or not editable" });
    return void sendInternalError(res, result.error);
  }

  res.json(result.shares);
}));

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete("/:workflowId/shares/:shareId", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const { workflowId, shareId } = req.params;
  const db = createServerSupabase();

  const result = await deleteWorkflowShare(db, { workflowId, shareId, userId });
  if (!result.ok) return void res.status(404).json({ detail: "Workflow not found" });
  res.status(204).send();
}));

// POST /workflows/:workflowId/share
workflowsRouter.post("/:workflowId/share", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const { emails, allow_edit } = req.body as { emails: string[]; allow_edit: boolean };

  if (!emails?.length) return void res.status(400).json({ detail: "emails is required" });

  const db = createServerSupabase();
  const result = await shareWorkflow(db, {
    workflowId,
    userId,
    userEmail,
    emails,
    allow_edit,
  });
  if (!result.ok) {
    if (result.kind === "not_found")
      return void res.status(404).json({ detail: "Workflow not found or not editable" });
    if (result.kind === "db_error")
      return void sendInternalError(res, result.error);
    return void res.status(400).json({ detail: result.detail });
  }

  res.status(204).send();
}));

workflowsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[workflows] unhandled route error", err);
    res.status(500).json({ detail: "Failed to process workflow request" });
  },
);
