// workflows types — implementation behind the module facade.
import { type ProjectRole } from "../../lib/permissions";

// Unexpected data-access failures travel back to the route as the raw error
// object. The route logs it and answers with the opaque internal-error body
// from lib/httpError, so driver messages never reach the client.
export type ServiceFailure = { ok: false; error: unknown };

export type WorkflowRecord = {
  id: string;
  user_id: string | null;
  org_id?: string | null;
  access_scope?: "private" | "shared" | "organization";
  organization_name?: string | null;
  direct_grant_count?: number;
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

export type WorkflowType = "assistant" | "tabular";

export type WorkflowContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};

export type WorkflowMetadata = {
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

export type OpenSourceSubmissionStatus = "pending" | "approved" | "rejected";

export type OpenSourceSubmissionRow = {
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

export type OpenSourceSubmissionSummary = Pick<
  OpenSourceSubmissionRow,
  "id" | "status" | "submitted_at" | "updated_at"
> & {
  reviewed_at?: string | null;
};

export const DEFAULT_WORKFLOW_CONTRIBUTOR: WorkflowContributor = {
  name: "Mike",
  organisation: null,
  role: null,
  linkedin: null,
};

export const DEFAULT_WORKFLOW_LANGUAGE = "English";

export const DEFAULT_WORKFLOW_PRACTICE = "General Transactions";

export const DEFAULT_WORKFLOW_JURISDICTIONS = ["General"];

export const WORKFLOW_CONTRIBUTIONS_ENABLED =
  process.env.WORKFLOW_CONTRIBUTIONS_ENABLED === "true";

export type WorkflowAccess =
  | {
      workflow: WorkflowRecord;
      role: ProjectRole;
      allowEdit: boolean;
      isOwner: boolean;
    }
  | null;
