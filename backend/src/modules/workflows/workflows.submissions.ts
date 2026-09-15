// workflows submissions — implementation behind the module facade.
import { type Db } from "../../lib/supabase";
import { OpenSourceSubmissionRow, OpenSourceSubmissionSummary, WorkflowRecord, WorkflowContributor, DEFAULT_WORKFLOW_CONTRIBUTOR } from "./workflows.types";

import { metadataFromWorkflowRecord, normalizeContributors, contributorFromName } from "./workflows.serialization";

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

export async function getLatestOpenSourceSubmission(
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

export type SubmitOpenSourceWorkflowResult =
  | {
      ok: true;
      status: number;
      body: OpenSourceSubmissionSummary & { mode: "created" | "updated" };
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "validation"; detail: string }
  | { ok: false; kind: "db_error"; error: unknown };

export async function submitOpenSourceWorkflow(
  db: Db,
  params: {
    workflowId: string;
    userId: string;
    userEmail: string | undefined;
    body: { contributor_mode?: unknown; contributor?: unknown };
  },
): Promise<SubmitOpenSourceWorkflowResult> {
  const { workflowId, userId, userEmail, body: openSourceBody } = params;
  const requestedContributorMode =
    openSourceBody.contributor_mode === "named" ? "named" : "anonymous";

  const { data: workflow, error: workflowError } = await db
    .from("workflows")
    .select("*")
    .eq("id", workflowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (workflowError) {
    return { ok: false, kind: "db_error", error: workflowError };
  }
  if (!workflow) {
    return { ok: false, kind: "not_found" };
  }

  const workflowRecord = workflow as WorkflowRecord;
  const validationError = validateOpenSourceWorkflow(workflowRecord);
  if (validationError) {
    return { ok: false, kind: "validation", detail: validationError };
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
    return { ok: false, kind: "db_error", error: pendingError };
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
      return {
        ok: false,
        kind: "db_error",
        error: updateError ?? new Error("Submission update returned no data"),
      };
    }
    return {
      ok: true,
      status: 200,
      body: {
        ...toOpenSourceSubmissionSummary(updated as OpenSourceSubmissionRow),
        mode: "updated",
      },
    };
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
    return {
      ok: false,
      kind: "db_error",
      error: createError ?? new Error("Submission create returned no data"),
    };
  }

  return {
    ok: true,
    status: 201,
    body: {
      ...toOpenSourceSubmissionSummary(created as OpenSourceSubmissionRow),
      mode: "created",
    },
  };
}
