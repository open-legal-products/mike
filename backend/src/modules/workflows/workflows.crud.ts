import { captureInlineDocumentCleanup, completeInlineDocumentCleanup } from "../documents/documents.service";
// workflows crud — implementation behind the module facade.
import { type Db } from "../../lib/supabase";
import { getOrgRole } from "../../lib/access";
// devLog comes from lib/chat/types (a leaf file — importing the whole chat
// barrel here just for a logger would be a heavy dependency edge).
import { devLog } from "../../lib/log";
import { WorkflowType, WorkflowMetadata, DEFAULT_WORKFLOW_LANGUAGE, DEFAULT_WORKFLOW_JURISDICTIONS, DEFAULT_WORKFLOW_PRACTICE, WorkflowRecord } from "./workflows.types";

import { normalizeOptionalString, normalizeJurisdictions, withWorkflowAccess, withDatabaseWorkflow, withOpenSourceSubmission } from "./workflows.serialization";

import { resolveWorkflowAccess, resolveCreatorScopedWorkflow } from "./workflows.access";

import { getLatestOpenSourceSubmission } from "./workflows.submissions";

export type CreateWorkflowResult =
  | { ok: true; workflow: Record<string, unknown> }
  | { ok: false; kind: "validation"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

export async function createWorkflow(
  db: Db,
  params: {
    userId: string;
    title: string;
    type: WorkflowType;
    skill_md?: string;
    columns_config?: unknown;
    metadata?: Partial<WorkflowMetadata>;
    org_id?: unknown;
  },
): Promise<CreateWorkflowResult> {
  const {
    userId,
    title,
    type,
    skill_md,
    columns_config,
    metadata,
    org_id,
  } = params;
  // Tenant assignment, exactly as POST /projects does it: an explicit
  // org_id must be one the caller belongs to, and its absence means
  // personal (org_id stays NULL, which IS the representation of personal
  // now that hidden personal orgs are gone). Workflows have no project to
  // inherit from, so an explicit id is the only context available.
  let orgId: string | null = null;
  if (org_id != null) {
    if (typeof org_id !== "string" || !org_id.trim())
      return {
        ok: false,
        kind: "validation",
        detail: "org_id must be a non-empty string",
      };
    const role = await getOrgRole(userId, org_id, db);
    if (!role)
      return {
        ok: false,
        kind: "validation",
        detail: "You are not a member of that organization.",
      };
    orgId = org_id;
  }
  devLog("[workflows/create] request", {
    userId,
    title: title.trim(),
    type,
    hasSkill: typeof skill_md === "string" && skill_md.length > 0,
    columnCount: Array.isArray(columns_config) ? columns_config.length : null,
    language:
      normalizeOptionalString(metadata?.language) ?? DEFAULT_WORKFLOW_LANGUAGE,
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
      org_id: orgId,
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
    return { ok: false, kind: "db_error", error };
  }
  devLog("[workflows/create] inserted", {
    id: data?.id,
    user_id: data?.user_id,
    title: data?.title,
    type: data?.type,
  });
  return {
    ok: true,
    workflow: withWorkflowAccess(
      withDatabaseWorkflow({
        ...(data as WorkflowRecord),
        access_scope: orgId ? "organization" : "private",
        organization_name: null,
      }),
      {
        role: "owner",
        allowEdit: true,
        isOwner: true,
      },
    ),
  };
}

export type UpdateWorkflowResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; kind: "not_editable" };

export async function updateWorkflow(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    body: {
      metadata?: Partial<WorkflowMetadata>;
      skill_md?: unknown;
      columns_config?: unknown;
    };
  },
): Promise<UpdateWorkflowResult> {
  const { workflowId, userId, userEmail, body } = params;
  const updates: Record<string, unknown> = {};
  const metadata = body.metadata;
  if (metadata?.title != null) updates.title = metadata.title;
  if (body.skill_md != null) updates.prompt_md = body.skill_md;
  if (body.columns_config != null)
    updates.columns_config = body.columns_config;
  if (metadata && "language" in metadata)
    updates.language = normalizeOptionalString(metadata.language);
  if (metadata && "practice" in metadata)
    updates.practice = metadata.practice ?? null;
  if (metadata && "jurisdictions" in metadata)
    updates.jurisdictions = normalizeJurisdictions(metadata.jurisdictions);

  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access || !access.allowEdit) {
    return { ok: false, kind: "not_editable" };
  }
  const { data, error } = await db
    .from("workflows")
    .update(updates)
    .eq("id", workflowId)
    .select("*")
    .single();
  if (error || !data) return { ok: false, kind: "not_editable" };
  return {
    ok: true,
    body: withWorkflowAccess(withDatabaseWorkflow(data as WorkflowRecord), {
      role: access.role,
      allowEdit: access.allowEdit,
      isOwner: access.isOwner,
    }),
  };
}

export type DeleteWorkflowResult =
  | { ok: true }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "db_error"; error: unknown };

export async function deleteWorkflow(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    workflowId: string;
  },
): Promise<DeleteWorkflowResult> {
  const { userId, userEmail, workflowId } = params;
  const workflow = await resolveCreatorScopedWorkflow(
    db,
    workflowId,
    userId,
    userEmail,
  );
  if (!workflow) return { ok: false, kind: "not_found" };

  const keys = await captureInlineDocumentCleanup(db, { workflowId });
  const { error } = await db
    .from("workflows")
    .delete()
    .eq("id", workflowId)
    .select("id");
  if (error) return { ok: false, kind: "db_error", error };
  await completeInlineDocumentCleanup(db, keys);
  return { ok: true };
}

export async function getWorkflowDetail(
  db: Db,
  params: { workflowId: string; userId: string; userEmail: string | undefined },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const { workflowId, userId, userEmail } = params;
  const access = await resolveWorkflowAccess(db, workflowId, userId, userEmail);
  if (!access) return { ok: false };
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
  return {
    ok: true,
    body: {
      ...withOpenSourceSubmission(
        withWorkflowAccess(withDatabaseWorkflow(access.workflow), {
          role: access.role,
          allowEdit: access.allowEdit,
          isOwner: access.isOwner,
        }),
        openSourceSubmission,
      ),
      is_default: !!installation,
    },
  };
}
