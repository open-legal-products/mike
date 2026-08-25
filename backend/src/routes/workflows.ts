import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import crypto from "crypto";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
  catalogWorkflowToLegacy,
  ensureDefaultWorkflows,
  findCatalogWorkflow,
  listActiveCatalogWorkflows,
  type LegacyCatalogWorkflow,
} from "../lib/workflowCatalog";
import { findMissingUserEmails } from "../lib/userLookup";
import { workflowNameFromSkillMd } from "../lib/workflowName";
import { parsePaginationQuery } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import { parseWorkflowSort } from "../lib/sort";
import {
  buildWorkflowIdsOverviewRpcArgs,
  buildWorkflowsOverviewRpcArgs,
  parseWorkflowScope,
} from "../lib/workflowsOverview";
import { sendInternalError } from "../lib/httpError";
import {
  deleteFile,
  getSignedUrl,
} from "../lib/storage";

export const workflowsRouter = Router();

type Db = ReturnType<typeof createServerSupabase>;
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

type WorkflowRecord = {
  id: string;
  user_id: string | null;
  is_system?: boolean;
  title?: string;
  type?: string;
  prompt_md?: string | null;
  columns_config?: unknown;
  language?: string | null;
  version?: string | null;
  practice?: string | null;
  jurisdictions?: string[] | null;
  created_at?: string;
  [key: string]: unknown;
};

type WorkflowType = "assistant" | "tabular";

type WorkflowContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};

type WorkflowMetadata = {
  name: string | null;
  title: string;
  description: string | null;
  type: WorkflowType;
  contributors: WorkflowContributor[];
  language: string;
  version: string | null;
  practice: string | null;
  jurisdictions: string[] | null;
};
type OpenSourceSubmissionStatus = "pending" | "approved" | "rejected";

type OpenSourceSubmissionRow = {
  id: string;
  workflow_id: string;
  submitted_by_user_id: string;
  submitter_email: string | null;
  submitter_name: string | null;
  contributor_mode?: "named" | "anonymous";
  status: OpenSourceSubmissionStatus;
  snapshot: unknown;
  submitted_at: string;
  updated_at: string;
  reviewed_at?: string | null;
  review_notes?: string | null;
};

type OpenSourceSubmissionSummary = Pick<
  OpenSourceSubmissionRow,
  "id" | "status" | "submitted_at" | "updated_at"
> & {
  reviewed_at?: string | null;
};

const DEFAULT_WORKFLOW_CONTRIBUTOR: WorkflowContributor = {
  name: "Mike",
  organisation: null,
  role: null,
  linkedin: null,
};
const DEFAULT_WORKFLOW_LANGUAGE = "English";
const DEFAULT_WORKFLOW_PRACTICE = "General Transactions";
const DEFAULT_WORKFLOW_JURISDICTIONS = ["General"];
const WORKFLOW_CONTRIBUTIONS_ENABLED =
  process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true";

type WorkflowAccess = {
  workflow: WorkflowRecord;
  allowEdit: boolean;
  isOwner: boolean;
} | null;

type AsyncRoute = (req: Request, res: Response) => Promise<unknown>;

function asyncRoute(handler: AsyncRoute) {
  return (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

async function ensureDefaultsForRequest(
  userId: string,
  db: Db,
  res: Response,
): Promise<boolean> {
  try {
    await ensureDefaultWorkflows(userId, db);
    return true;
  } catch (error) {
    sendInternalError(res, error);
    return false;
  }
}

function withWorkflowAccess<T extends object>(
  workflow: T,
  access: {
    allowEdit: boolean;
    isOwner: boolean;
    sharedByName?: string | null;
  },
) {
  return {
    ...workflow,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

function withOpenSourceSubmission<T extends object>(
  workflow: T,
  submission: OpenSourceSubmissionSummary | null,
) {
  return {
    ...workflow,
    open_source_submission: submission,
  };
}

function withSystemWorkflowAccess(workflow: LegacyCatalogWorkflow) {
  return withWorkflowAccess(workflow, {
    allowEdit: false,
    isOwner: false,
  });
}

function workflowTypeFrom(value: unknown): WorkflowType {
  return value === "tabular" ? "tabular" : "assistant";
}

function rejectReferenceFilesForTabularWorkflow(
  access: NonNullable<WorkflowAccess>,
  res: Response,
): boolean {
  if (workflowTypeFrom(access.workflow.type) === "assistant") return false;
  res.status(400).json({
    detail: "Reference files are only available for assistant workflows",
  });
  return true;
}

function metadataFromWorkflowRecord(
  workflow: WorkflowRecord,
): WorkflowMetadata {
  const type = workflowTypeFrom(workflow.type);
  return {
    name: workflowNameFromSkillMd(workflow.prompt_md),
    title: workflow.title ?? "",
    description: null,
    type,
    contributors: normalizeContributors(workflow.contributors) ?? [
      DEFAULT_WORKFLOW_CONTRIBUTOR,
    ],
    language: workflow.language ?? DEFAULT_WORKFLOW_LANGUAGE,
    version: workflow.version ?? null,
    practice: workflow.practice ?? DEFAULT_WORKFLOW_PRACTICE,
    jurisdictions: workflow.jurisdictions ?? DEFAULT_WORKFLOW_JURISDICTIONS,
  };
}

function withDatabaseWorkflow(workflow: WorkflowRecord) {
  const {
    title: _title,
    type: _type,
    contributors: _contributors,
    language: _language,
    version: _version,
    practice: _practice,
    jurisdictions: _jurisdictions,
    prompt_md,
    ...rest
  } = workflow;
  return {
    ...rest,
    metadata: metadataFromWorkflowRecord(workflow),
    skill_md: prompt_md ?? null,
    is_system: false,
  };
}

function withDatabaseWorkflowSummary(workflow: WorkflowRecord) {
  return {
    ...withDatabaseWorkflow(workflow),
    // List pages only need metadata. The detail route loads the full content.
    skill_md: null,
    columns_config: null,
  };
}

async function markDefaultWorkflows<T extends { id: string }>(
  db: Db,
  userId: string,
  workflows: T[],
): Promise<Array<T & { is_default: boolean; default_key: string | null }>> {
  if (workflows.length === 0) return [];
  const { data, error } = await db
    .from("default_workflow_installations")
    .select("workflow_id, default_key")
    .eq("user_id", userId)
    .in(
      "workflow_id",
      workflows.map((workflow) => workflow.id),
    );
  if (error) throw error;
  const defaultKeyByWorkflowId = new Map(
    (data ?? []).flatMap((row) =>
      row.workflow_id && row.default_key
        ? [[row.workflow_id, row.default_key] as const]
        : [],
    ),
  );
  return workflows.map((workflow) => ({
    ...workflow,
    is_default: defaultKeyByWorkflowId.has(workflow.id),
    default_key: defaultKeyByWorkflowId.get(workflow.id) ?? null,
  }));
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeJurisdictions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => !!item);
  return items.length > 0 ? Array.from(new Set(items)) : null;
}

function normalizeContributors(value: unknown): WorkflowContributor[] | null {
  if (!Array.isArray(value)) return null;
  const contributors = value
    .map((item): WorkflowContributor | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const name = normalizeOptionalString(record.name);
      if (!name) return null;
      return {
        name,
        organisation: normalizeOptionalString(record.organisation),
        role: normalizeOptionalString(record.role),
        linkedin: normalizeOptionalString(record.linkedin),
      };
    })
    .filter((item): item is WorkflowContributor => !!item);
  return contributors.length ? contributors : null;
}

function contributorFromName(name: unknown): WorkflowContributor {
  return {
    ...DEFAULT_WORKFLOW_CONTRIBUTOR,
    name: normalizeOptionalString(name) ?? DEFAULT_WORKFLOW_CONTRIBUTOR.name,
  };
}

async function resolveWorkflowAccess(
  workflowId: string,
  userId: string,
  userEmail: string | null | undefined,
  db: Db,
): Promise<WorkflowAccess> {
  const { data: workflow } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .single();
  if (!workflow) return null;
  const workflowRecord = workflow as WorkflowRecord;
  if (workflowRecord.user_id === userId) {
    return { workflow: workflowRecord, allowEdit: true, isOwner: true };
  }

  const normalizedUserEmail = (userEmail ?? "").trim().toLowerCase();
  if (!normalizedUserEmail) return null;

  const { data: share } = await db
    .from("workflow_shares")
    .select("allow_edit")
    .eq("workflow_id", workflowId)
    .eq("shared_with_email", normalizedUserEmail)
    .maybeSingle();
  if (!share) return null;

  return {
    workflow: workflowRecord,
    allowEdit: !!share.allow_edit,
    isOwner: false,
  };
}

function toOpenSourceSubmissionSummary(
  row: OpenSourceSubmissionRow,
): OpenSourceSubmissionSummary {
  return {
    id: row.id,
    status: row.status,
    submitted_at: row.submitted_at,
    updated_at: row.updated_at,
    reviewed_at: row.reviewed_at ?? null,
  };
}

async function getLatestOpenSourceSubmission(
  db: Db,
  workflowId: string,
  userId: string,
): Promise<OpenSourceSubmissionSummary | null> {
  const { data, error } = await db
    .from("workflow_open_source_submissions")
    .select("id, status, submitted_at, updated_at, reviewed_at")
    .eq("workflow_id", workflowId)
    .eq("submitted_by_user_id", userId)
    .order("submitted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data
    ? toOpenSourceSubmissionSummary(data as OpenSourceSubmissionRow)
    : null;
}

function buildOpenSourceSnapshot(
  workflow: WorkflowRecord,
  contributors: WorkflowContributor[],
  contributorMode: "named" | "anonymous",
) {
  return {
    workflow_id: workflow.id,
    metadata: {
      ...metadataFromWorkflowRecord(workflow),
      contributors,
    },
    skill_md: workflow.prompt_md ?? null,
    columns_config: workflow.columns_config ?? null,
    contributor_mode: contributorMode,
    created_at: workflow.created_at ?? null,
  };
}

function validateOpenSourceWorkflow(workflow: WorkflowRecord): string | null {
  if (workflow.type === "assistant") {
    return typeof workflow.prompt_md === "string" && workflow.prompt_md.trim()
      ? null
      : "Assistant workflows need instructions before they can be opened source.";
  }
  if (workflow.type === "tabular") {
    return Array.isArray(workflow.columns_config) &&
      workflow.columns_config.length > 0
      ? null
      : "Tabular workflows need at least one column before they can be opened source.";
  }
  return "Workflow type must be 'assistant' or 'tabular'.";
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
workflowsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { type } = req.query as { type?: string };
    const db = createServerSupabase();
    const workflowType = typeof type === "string" && type ? type : null;

    if (!(await ensureDefaultsForRequest(userId, db, res))) return;

    const hasPaginationParams = WORKFLOW_PAGINATION_QUERY_KEYS.some(
      (key) => req.query[key] !== undefined,
    );
    if (hasPaginationParams) {
      const rpcArgs = buildWorkflowsOverviewRpcArgs({
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
      });
      const { data, error } = await db.rpc("get_workflows_overview", rpcArgs);
      if (error) return void sendInternalError(res, error);
      const workflows = ((data ?? []) as WorkflowRecord[]).map(
        withDatabaseWorkflowSummary,
      );
      return void res.json(await markDefaultWorkflows(db, userId, workflows));
    }

    const { data, error } = await db.rpc("get_workflows_overview", {
      p_user_id: userId,
      p_user_email: userEmail ?? null,
      p_type: workflowType,
    });
    if (error) {
      return void sendInternalError(res, error);
    }

    const databaseWorkflows = ((data ?? []) as WorkflowRecord[]).map(
      withDatabaseWorkflow,
    );
    res.json(await markDefaultWorkflows(db, userId, databaseWorkflows));
  }),
);

// Retained as a compatibility endpoint for older clients. The restructured
// Workflows page no longer exposes a System tab; non-default catalog entries
// are presented through /workflow-addons instead.
workflowsRouter.get(
  "/system",
  requireAuth,
  asyncRoute(async (req, res) => {
    const workflowType =
      req.query.type === "assistant" || req.query.type === "tabular"
        ? req.query.type
        : null;
    const db = createServerSupabase();
    const catalog = await listActiveCatalogWorkflows(db, {
      type: workflowType,
    });
    res.json(
      catalog
        .map(catalogWorkflowToLegacy)
        .map(withSystemWorkflowAccess),
    );
  }),
);

// GET /workflows/filter-options (must come before /:workflowId routes)
workflowsRouter.get(
  "/filter-options",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const type =
      req.query.type === "assistant" || req.query.type === "tabular"
        ? req.query.type
        : null;
    const scope = parseWorkflowScope(req.query.scope);
    const db = createServerSupabase();
    if (!(await ensureDefaultsForRequest(userId, db, res))) return;
    const { data, error } = await db.rpc("get_workflow_filter_options", {
      p_user_id: userId,
      p_user_email: userEmail ?? null,
      p_type: type,
      p_scope: scope,
    });
    if (error) return void sendInternalError(res, error);

    const row = (data?.[0] ?? {}) as Record<string, unknown>;
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    res.json({
      practices: strings(row.practices),
      languages: strings(row.languages),
      jurisdictions: strings(row.jurisdictions),
    });
  }),
);

const WORKFLOW_IDS_PAGE_SIZE = 1000;
const WORKFLOW_IDS_MAX_PAGES = 200;

// GET /workflows/ids (must come before /:workflowId routes)
workflowsRouter.get(
  "/ids",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    if (!(await ensureDefaultsForRequest(userId, db, res))) return;

    const workflowType =
      typeof req.query.type === "string" && req.query.type
        ? req.query.type
        : null;
    const searchTerm = normalizeSearchTerm(req.query.search);
    const scope = parseWorkflowScope(req.query.scope);
    const practice = normalizeSearchTerm(req.query.practice);
    const language = normalizeSearchTerm(req.query.language);
    const jurisdiction = normalizeSearchTerm(req.query.jurisdiction);

    const ids: { id: string; user_id: string }[] = [];
    let offset = 0;
    for (let page = 0; page < WORKFLOW_IDS_MAX_PAGES; page += 1) {
      const rpcArgs = buildWorkflowIdsOverviewRpcArgs({
        userId,
        userEmail,
        type: workflowType,
        scope,
        searchTerm,
        practice,
        language,
        jurisdiction,
        pagination: { limit: WORKFLOW_IDS_PAGE_SIZE, offset },
      });
      const { data, error } = await db.rpc(
        "get_workflow_ids_overview",
        rpcArgs,
      );
      if (error) return void sendInternalError(res, error);
      const rows = (data ?? []) as { id: string; user_id: string }[];
      if (rows.length === 0) break;
      ids.push(...rows);
      offset += rows.length;
    }

    res.json(ids);
  }),
);

// POST /workflows
workflowsRouter.post(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { metadata, skill_md, columns_config } = req.body as {
      metadata?: Partial<WorkflowMetadata>;
      skill_md?: string;
      columns_config?: unknown;
    };
    const title = metadata?.title;
    const type = metadata?.type;
    if (!title?.trim())
      return void res
        .status(400)
        .json({ detail: "metadata.title is required" });
    if (type !== "assistant" && type !== "tabular")
      return void res
        .status(400)
        .json({ detail: "metadata.type must be 'assistant' or 'tabular'" });

    const db = createServerSupabase();
    devLog("[workflows/create] request", {
      userId,
      title: title.trim(),
      type,
      hasSkill: typeof skill_md === "string" && skill_md.length > 0,
      columnCount: Array.isArray(columns_config) ? columns_config.length : null,
      language:
        normalizeOptionalString(metadata?.language) ??
        DEFAULT_WORKFLOW_LANGUAGE,
      practice: metadata?.practice ?? null,
      jurisdictions:
        normalizeJurisdictions(metadata?.jurisdictions) ??
        DEFAULT_WORKFLOW_JURISDICTIONS,
    });
    const { data, error } = await db
      .from("workflows")
      .insert({
        user_id: userId,
        title: title.trim(),
        type,
        prompt_md: skill_md ?? null,
        columns_config: columns_config ?? null,
        language:
          normalizeOptionalString(metadata?.language) ??
          DEFAULT_WORKFLOW_LANGUAGE,
        practice:
          normalizeOptionalString(metadata?.practice) ??
          DEFAULT_WORKFLOW_PRACTICE,
        jurisdictions:
          normalizeJurisdictions(metadata?.jurisdictions) ??
          DEFAULT_WORKFLOW_JURISDICTIONS,
      })
      .select("*")
      .single();
    if (error) {
      devLog("[workflows/create] insert error", {
        userId,
        title: title.trim(),
        type,
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint,
      });
      return void sendInternalError(res, error);
    }
    devLog("[workflows/create] inserted", {
      id: data?.id,
      user_id: data?.user_id,
      title: data?.title,
      type: data?.type,
    });
    res.status(201).json(withDatabaseWorkflow(data as WorkflowRecord));
  }),
);

async function handleWorkflowUpdate(req: Request, res: Response) {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const { workflowId } = req.params;
  const updates: Record<string, unknown> = {};
  const metadata = req.body.metadata as Partial<WorkflowMetadata> | undefined;
  if (metadata?.title != null) updates.title = metadata.title;
  if (req.body.skill_md != null) updates.prompt_md = req.body.skill_md;
  if (req.body.columns_config != null)
    updates.columns_config = req.body.columns_config;
  if (metadata && "language" in metadata)
    updates.language = normalizeOptionalString(metadata.language);
  if (metadata && "practice" in metadata)
    updates.practice = metadata.practice ?? null;
  if (metadata && "jurisdictions" in metadata)
    updates.jurisdictions = normalizeJurisdictions(metadata.jurisdictions);

  const db = createServerSupabase();
  const access = await resolveWorkflowAccess(workflowId, userId, userEmail, db);
  if (!access || !access.allowEdit) {
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .select("*")
    .single();
  if (error || !data)
    return void res
      .status(404)
      .json({ detail: "Workflow not found or not editable" });
  res.json(
    withWorkflowAccess(withDatabaseWorkflow(data as WorkflowRecord), {
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  );
}

// PUT /workflows/:workflowId
workflowsRouter.put(
  "/:workflowId",
  requireAuth,
  asyncRoute(handleWorkflowUpdate),
);

// PATCH /workflows/:workflowId
workflowsRouter.patch(
  "/:workflowId",
  requireAuth,
  asyncRoute(handleWorkflowUpdate),
);

// DELETE /workflows/:workflowId
workflowsRouter.delete(
  "/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const catalogWorkflow = await findCatalogWorkflow(workflowId, db);
    if (catalogWorkflow) {
      return void res.json(
        withSystemWorkflowAccess(catalogWorkflowToLegacy(catalogWorkflow)),
      );
    }

    const { data: referenceDocuments } = await db
      .from("workflow_reference_documents")
      .select("storage_path")
      .eq("workflow_id", workflowId)
      .eq("user_id", userId);
    const { data: deleted, error } = await db
      .from("workflows")
      .delete()
      .eq("id", workflowId)
      .eq("user_id", userId)
      .select("id");
    if (error) return void sendInternalError(res, error);
    if ((deleted ?? []).length > 0) {
      await Promise.all(
        (referenceDocuments ?? []).map((reference) =>
          deleteFile(reference.storage_path).catch(() => {}),
        ),
      );
    }
    res.status(204).send();
  }),
);

// GET /workflows/hidden
workflowsRouter.get(
  "/hidden",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const { data, error } = await db
      .from("hidden_workflows")
      .select("workflow_id")
      .eq("user_id", userId);
    if (error) return void sendInternalError(res, error);
    res.json((data ?? []).map((r) => r.workflow_id));
  }),
);

// POST /workflows/hidden
workflowsRouter.post(
  "/hidden",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflow_id } = req.body as { workflow_id: string };
    if (!workflow_id?.trim())
      return void res.status(400).json({ detail: "workflow_id is required" });
    const db = createServerSupabase();
    const { error } = await db
      .from("hidden_workflows")
      .upsert(
        { user_id: userId, workflow_id },
        { onConflict: "user_id,workflow_id" },
      );
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
  }),
);

// DELETE /workflows/hidden/:workflowId
workflowsRouter.delete(
  "/hidden/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const { error } = await db
      .from("hidden_workflows")
      .delete()
      .eq("user_id", userId)
      .eq("workflow_id", workflowId);
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
  }),
);

// POST /workflows/:workflowId/open-source
workflowsRouter.post(
  "/:workflowId/open-source",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!WORKFLOW_CONTRIBUTIONS_ENABLED) {
      return void res
        .status(404)
        .json({ detail: "Workflow contributions are disabled" });
    }

    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const openSourceBody = req.body as {
      contributor_mode?: unknown;
      contributor?: unknown;
    };
    const requestedContributorMode =
      openSourceBody.contributor_mode === "named" ? "named" : "anonymous";
    const db = createServerSupabase();

    const { data: workflow, error: workflowError } = await db
      .from("workflows")
      .select("*")
      .eq("id", workflowId)
      .eq("user_id", userId)
      .maybeSingle();
    if (workflowError) {
      return void sendInternalError(res, workflowError);
    }
    if (!workflow) {
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not open-sourceable" });
    }

    const workflowRecord = workflow as WorkflowRecord;
    const validationError = validateOpenSourceWorkflow(workflowRecord);
    if (validationError) {
      return void res.status(400).json({ detail: validationError });
    }

    const { data: profile } = await db
      .from("user_profiles")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    const submitterName =
      typeof profile?.display_name === "string" && profile.display_name.trim()
        ? profile.display_name.trim()
        : null;
    const submittedContributor =
      normalizeContributors([openSourceBody.contributor])?.[0] ??
      contributorFromName(submitterName || userEmail);
    const publicContributors =
      requestedContributorMode === "named"
        ? [submittedContributor]
        : [DEFAULT_WORKFLOW_CONTRIBUTOR];
    const now = new Date().toISOString();
    const snapshot = buildOpenSourceSnapshot(
      workflowRecord,
      publicContributors,
      requestedContributorMode,
    );

    const { data: pendingSubmission, error: pendingError } = await db
      .from("workflow_open_source_submissions")
      .select("*")
      .eq("workflow_id", workflowId)
      .eq("submitted_by_user_id", userId)
      .eq("status", "pending")
      .maybeSingle();
    if (pendingError) {
      return void sendInternalError(res, pendingError);
    }

    if (pendingSubmission) {
      const { data: updated, error: updateError } = await db
        .from("workflow_open_source_submissions")
        .update({
          submitter_email: userEmail ?? null,
          submitter_name:
            requestedContributorMode === "named" ? submitterName : null,
          contributor_mode: requestedContributorMode,
          snapshot,
          updated_at: now,
        })
        .eq("id", pendingSubmission.id)
        .select("id, status, submitted_at, updated_at, reviewed_at")
        .single();
      if (updateError || !updated) {
        return void sendInternalError(
          res,
          updateError ?? new Error("Submission update returned no data"),
        );
      }
      return void res.json({
        ...toOpenSourceSubmissionSummary(updated as OpenSourceSubmissionRow),
        mode: "updated",
      });
    }

    const { data: created, error: createError } = await db
      .from("workflow_open_source_submissions")
      .insert({
        workflow_id: workflowId,
        submitted_by_user_id: userId,
        submitter_email: userEmail ?? null,
        submitter_name:
          requestedContributorMode === "named" ? submitterName : null,
        contributor_mode: requestedContributorMode,
        status: "pending",
        snapshot,
        submitted_at: now,
        updated_at: now,
      })
      .select("id, status, submitted_at, updated_at, reviewed_at")
      .single();
    if (createError || !created) {
      return void sendInternalError(
        res,
        createError ?? new Error("Submission create returned no data"),
      );
    }

    res.status(201).json({
      ...toOpenSourceSubmissionSummary(created as OpenSourceSubmissionRow),
      mode: "created",
    });
  }),
);

// GET /workflows/:workflowId/reference-files
workflowsRouter.get(
  "/:workflowId/reference-files",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const access = await resolveWorkflowAccess(
      req.params.workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });
    if (rejectReferenceFilesForTabularWorkflow(access, res)) return;

    const { data, error } = await db
      .from("workflow_reference_documents")
      .select(
        "id, workflow_id, filename, file_type, size_bytes, created_at, updated_at",
      )
      .eq("workflow_id", req.params.workflowId)
      .order("created_at", { ascending: true });
    if (error) return void sendInternalError(res, error);
    res.json(data ?? []);
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
    const access = await resolveWorkflowAccess(
      req.params.workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });
    if (rejectReferenceFilesForTabularWorkflow(access, res)) return;
    const { data: reference } = await db
      .from("workflow_reference_documents")
      .select("id, filename, storage_path")
      .eq("id", req.params.referenceId)
      .eq("workflow_id", req.params.workflowId)
      .maybeSingle();
    if (!reference)
      return void res.status(404).json({ detail: "Reference file not found" });
    const url = await getSignedUrl(
      reference.storage_path,
      3600,
      reference.filename,
    );
    if (!url)
      return void res.status(503).json({ detail: "Storage not configured" });
    res.json({ url, filename: reference.filename });
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
    const access = await resolveWorkflowAccess(
      req.params.workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access || !access.allowEdit) {
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });
    }
    if (rejectReferenceFilesForTabularWorkflow(access, res)) return;
    const { data: reference } = await db
      .from("workflow_reference_documents")
      .select("id, storage_path")
      .eq("id", req.params.referenceId)
      .eq("workflow_id", req.params.workflowId)
      .maybeSingle();
    if (!reference) {
      return void res.status(404).json({ detail: "Reference file not found" });
    }
    await deleteFile(reference.storage_path).catch(() => {});
    const { error } = await db
      .from("workflow_reference_documents")
      .delete()
      .eq("id", reference.id);
    if (error) return void sendInternalError(res, error);
    res.status(204).send();
  }),
);

// GET /workflows/:workflowId
workflowsRouter.get(
  "/:workflowId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const db = createServerSupabase();
    const catalogWorkflow = await findCatalogWorkflow(workflowId, db);
    if (catalogWorkflow) {
      return void res.json(
        withSystemWorkflowAccess(catalogWorkflowToLegacy(catalogWorkflow)),
      );
    }

    const access = await resolveWorkflowAccess(
      workflowId,
      userId,
      userEmail,
      db,
    );
    if (!access)
      return void res.status(404).json({ detail: "Workflow not found" });
    const openSourceSubmission = access.isOwner
      ? await getLatestOpenSourceSubmission(db, workflowId, userId)
      : null;
    const { data: installation } = access.isOwner
      ? await db
          .from("default_workflow_installations")
          .select("id")
          .eq("workflow_id", workflowId)
          .eq("user_id", userId)
          .maybeSingle()
      : { data: null };
    res.json({
      ...withOpenSourceSubmission(
        withWorkflowAccess(withDatabaseWorkflow(access.workflow), {
          allowEdit: access.allowEdit,
          isOwner: access.isOwner,
        }),
        openSourceSubmission,
      ),
      is_default: !!installation,
    });
  }),
);

// GET /workflows/:workflowId/shares
workflowsRouter.get(
  "/:workflowId/shares",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId } = req.params;
    const db = createServerSupabase();

    const { data: wf } = await db
      .from("workflows")
      .select("id")
      .eq("id", workflowId)
      .eq("user_id", userId)
      .single();
    if (!wf)
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });

    const { data: shares, error } = await db
      .from("workflow_shares")
      .select("id, shared_with_email, allow_edit, created_at")
      .eq("workflow_id", workflowId)
      .order("created_at", { ascending: true });
    if (error) return void sendInternalError(res, error);

    res.json(shares ?? []);
  }),
);

// DELETE /workflows/:workflowId/shares/:shareId
workflowsRouter.delete(
  "/:workflowId/shares/:shareId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const { workflowId, shareId } = req.params;
    const db = createServerSupabase();

    const { data: wf } = await db
      .from("workflows")
      .select("id")
      .eq("id", workflowId)
      .eq("user_id", userId)
      .single();
    if (!wf) return void res.status(404).json({ detail: "Workflow not found" });

    await db
      .from("workflow_shares")
      .delete()
      .eq("id", shareId)
      .eq("workflow_id", workflowId);
    res.status(204).send();
  }),
);

// POST /workflows/:workflowId/share
workflowsRouter.post(
  "/:workflowId/share",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { workflowId } = req.params;
    const { emails, allow_edit } = req.body as {
      emails: string[];
      allow_edit: boolean;
    };

    if (!emails?.length)
      return void res.status(400).json({ detail: "emails is required" });
    const normalizedEmails = [
      ...new Set(
        emails.map((email) => email.trim().toLowerCase()).filter(Boolean),
      ),
    ];
    if (normalizedEmails.length === 0) {
      return void res.status(400).json({ detail: "emails is required" });
    }
    const normalizedUserEmail = userEmail?.trim().toLowerCase();
    if (normalizedUserEmail && normalizedEmails.includes(normalizedUserEmail)) {
      return void res
        .status(400)
        .json({ detail: "You cannot share a workflow with yourself." });
    }

    const db = createServerSupabase();
    const missingSharedUsers = await findMissingUserEmails(
      db,
      normalizedEmails,
    );
    if (missingSharedUsers.length > 0) {
      return void res.status(400).json({
        detail: `${missingSharedUsers[0]} does not belong to a Mike user.`,
      });
    }

    // Verify ownership
    const { data: wf } = await db
      .from("workflows")
      .select("id")
      .eq("id", workflowId)
      .eq("user_id", userId)
      .single();
    if (!wf)
      return void res
        .status(404)
        .json({ detail: "Workflow not found or not editable" });

    const rows = normalizedEmails.map((email: string) => ({
      workflow_id: workflowId,
      shared_by_user_id: userId,
      shared_with_email: email,
      allow_edit: allow_edit ?? false,
    }));
    // Upsert on (workflow_id, shared_with_email) so re-sharing to the same
    // person updates the existing row instead of stacking duplicates.
    const { error } = await db
      .from("workflow_shares")
      .upsert(rows, { onConflict: "workflow_id,shared_with_email" });
    if (error) return void sendInternalError(res, error);

    res.status(204).send();
  }),
);

workflowsRouter.use(
  (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    console.error("[workflows] unhandled route error", err);
    res.status(500).json({ detail: "Failed to process workflow request" });
  },
);
