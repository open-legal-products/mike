// HTTP surface for the workflows module. Handlers parse params/query/body,
// call the service layer in workflows.service.ts, and map its typed results
// onto status codes and JSON responses.

import { Router, type Request, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { parsePaginationQuery } from "../../lib/pagination";
import { normalizeSearchTerm } from "../../lib/search";
import { parseWorkflowSort } from "../../lib/sort";
import { parseWorkflowScope } from "../../lib/workflowsOverview";
import { singleFileUpload } from "../../lib/upload";
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
  listReferenceFiles,
  uploadReferenceFile,
  getReferenceFileUrl,
  replaceReferenceFile,
  deleteReferenceFile,
  listWorkflowShares,
  deleteWorkflowShare,
  shareWorkflow,
  type ReferenceFileFailure,
  type WorkflowMetadata,
} from "./workflows.service";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;

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

// Maps a reference-file service failure onto the status code + detail the
// monolith used for that condition.
function sendReferenceFileFailure(res: Response, failure: ReferenceFileFailure) {
  switch (failure.kind) {
    case "workflow_not_found":
      return void res.status(404).json({ detail: "Workflow not found" });
    case "not_editable":
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });
    case "tabular_unsupported":
      return void res.status(400).json({
        detail: "Reference files are only available for assistant workflows",
      });
    case "file_required":
      return void res.status(400).json({ detail: "file is required" });
    case "unsupported_type":
      return void res.status(400).json({ detail: failure.detail });
    case "reference_not_found":
      return void res
        .status(404)
        .json({ detail: "Reference file not found" });
    case "storage_unconfigured":
      return void res.status(503).json({ detail: "Storage not configured" });
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

// GET /workflows/:workflowId/reference-files
workflowsRouter.get("/:workflowId/reference-files", requireAuth, asyncRoute(async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const db = createServerSupabase();
  const result = await listReferenceFiles(db, {
    workflowId: req.params.workflowId,
    userId,
    userEmail,
  });
  if (!result.ok) return sendReferenceFileFailure(res, result);
  res.json(result.files);
}));

// POST /workflows/:workflowId/reference-files
workflowsRouter.post(
  "/:workflowId/reference-files",
  requireAuth,
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await uploadReferenceFile(db, {
      workflowId: req.params.workflowId,
      userId,
      userEmail,
      file: req.file,
    });
    if (!result.ok) return sendReferenceFileFailure(res, result);
    res.status(201).json(result.file);
  }),
);

// GET /workflows/:workflowId/reference-files/:referenceId/url
workflowsRouter.get(
  "/:workflowId/reference-files/:referenceId/url",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await getReferenceFileUrl(db, {
      workflowId: req.params.workflowId,
      referenceId: req.params.referenceId,
      userId,
      userEmail,
    });
    if (!result.ok) return sendReferenceFileFailure(res, result);
    res.json({ url: result.url, filename: result.filename });
  }),
);

// PUT /workflows/:workflowId/reference-files/:referenceId
workflowsRouter.put(
  "/:workflowId/reference-files/:referenceId",
  requireAuth,
  singleFileUpload("file"),
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await replaceReferenceFile(db, {
      workflowId: req.params.workflowId,
      referenceId: req.params.referenceId,
      userId,
      userEmail,
      file: req.file,
    });
    if (!result.ok) return sendReferenceFileFailure(res, result);
    res.json(result.file);
  }),
);

// DELETE /workflows/:workflowId/reference-files/:referenceId
workflowsRouter.delete(
  "/:workflowId/reference-files/:referenceId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await deleteReferenceFile(db, {
      workflowId: req.params.workflowId,
      referenceId: req.params.referenceId,
      userId,
      userEmail,
    });
    if (!result.ok) return sendReferenceFileFailure(res, result);
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
  routerErrorHandler("[workflows]"),
);
