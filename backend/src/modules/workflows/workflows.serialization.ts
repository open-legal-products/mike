// workflows serialization — implementation behind the module facade.
import { type LegacyCatalogWorkflow } from "../../lib/workflowCatalog";
import { workflowNameFromSkillMd } from "./workflows.name";
import { type ProjectRole } from "../../lib/permissions";
import { OpenSourceSubmissionSummary, WorkflowType, WorkflowRecord, WorkflowMetadata, DEFAULT_WORKFLOW_CONTRIBUTOR, DEFAULT_WORKFLOW_LANGUAGE, DEFAULT_WORKFLOW_PRACTICE, DEFAULT_WORKFLOW_JURISDICTIONS, WorkflowContributor } from "./workflows.types";

export function withWorkflowAccess<T extends object>(
  workflow: T,
  access: {
    role: ProjectRole;
    allowEdit: boolean;
    isOwner: boolean;
    sharedByName?: string | null;
  },
) {
  return {
    ...workflow,
    access_role: access.role,
    allow_edit: access.allowEdit,
    is_owner: access.isOwner,
    shared_by_name: access.sharedByName ?? null,
  };
}

export function withOpenSourceSubmission<T extends object>(
  workflow: T,
  submission: OpenSourceSubmissionSummary | null,
) {
  return {
    ...workflow,
    open_source_submission: submission,
  };
}

export function withSystemWorkflowAccess(workflow: LegacyCatalogWorkflow) {
  return withWorkflowAccess(workflow, {
    role: "viewer",
    allowEdit: false,
    isOwner: false,
  });
}

export function workflowTypeFrom(value: unknown): WorkflowType {
  return value === "tabular" ? "tabular" : "assistant";
}

export function metadataFromWorkflowRecord(
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

// Exported for the workflow-addons import route, whose 201 body must match
// GET /workflows/:id. Hand-rebuilding that shape there had already drifted on
// metadata.name, contributors, version and is_default.
export function withDatabaseWorkflow(workflow: WorkflowRecord) {
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

export function withDatabaseWorkflowSummary(workflow: WorkflowRecord) {
  return {
    ...withDatabaseWorkflow(workflow),
    // List pages only need metadata. The detail route loads the full content.
    skill_md: null,
    columns_config: null,
  };
}

export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function normalizeJurisdictions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => !!item);
  return items.length > 0 ? Array.from(new Set(items)) : null;
}

export function normalizeContributors(value: unknown): WorkflowContributor[] | null {
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

export function contributorFromName(name: unknown): WorkflowContributor {
  return {
    ...DEFAULT_WORKFLOW_CONTRIBUTOR,
    name: normalizeOptionalString(name) ?? DEFAULT_WORKFLOW_CONTRIBUTOR.name,
  };
}
