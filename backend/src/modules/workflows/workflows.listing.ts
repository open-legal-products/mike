// workflows listing — implementation behind the module facade.
import { type Db } from "../../lib/supabase";
import { type PaginationParams } from "../../lib/pagination";
import { type WorkflowSort } from "../../lib/sort";
import { buildWorkflowIdsOverviewRpcArgs, buildWorkflowsOverviewRpcArgs, type WorkflowScope } from "./workflows.overview";
import { ensureResourceAccessSummaries } from "../../lib/resourceAccessSummary";
import { ServiceFailure, WorkflowRecord, WorkflowType } from "./workflows.types";

import { withDatabaseWorkflow, withDatabaseWorkflowSummary } from "./workflows.serialization";
import { markDefaultWorkflows } from "./workflows.catalog";

export async function listWorkflows(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: string | null;
  },
): Promise<{ ok: true; data: unknown } | ServiceFailure> {
  const { userId, userEmail, type: workflowType } = params;
  const { data, error } = await db.rpc("get_workflows_overview", {
    p_user_id: userId,
    p_user_email: userEmail ?? null,
    p_type: workflowType,
  });
  if (error) {
    return { ok: false, error };
  }

  const accessSummary = await ensureResourceAccessSummaries(
    db,
    "workflow",
    (data ?? []) as WorkflowRecord[],
  );
  if (accessSummary.error) return { ok: false, error: accessSummary.error };
  const databaseWorkflows = accessSummary.rows.map(withDatabaseWorkflow);
  return {
    ok: true,
    data: await markDefaultWorkflows(db, userId, databaseWorkflows),
  };
}

export async function listWorkflowsPage(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: string | null;
    scope: WorkflowScope;
    pagination: PaginationParams;
    searchTerm: string | null;
    sort: WorkflowSort;
    practice: string | null;
    language: string | null;
    jurisdiction: string | null;
  },
): Promise<{ ok: true; data: unknown } | ServiceFailure> {
  const rpcArgs = buildWorkflowsOverviewRpcArgs(params);
  const { data, error } = await db.rpc("get_workflows_overview", rpcArgs);
  if (error) return { ok: false, error };
  const accessSummary = await ensureResourceAccessSummaries(
    db,
    "workflow",
    (data ?? []) as WorkflowRecord[],
  );
  if (accessSummary.error) return { ok: false, error: accessSummary.error };
  const workflows = accessSummary.rows.map(withDatabaseWorkflowSummary);
  return {
    ok: true,
    data: await markDefaultWorkflows(db, params.userId, workflows),
  };
}

export async function getWorkflowFilterOptions(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: WorkflowType | null;
    scope: WorkflowScope;
  },
): Promise<
  | {
      ok: true;
      options: {
        practices: string[];
        languages: string[];
        jurisdictions: string[];
      };
    }
  | ServiceFailure
> {
  const { data, error } = await db.rpc("get_workflow_filter_options", {
    p_user_id: params.userId,
    p_user_email: params.userEmail ?? null,
    p_type: params.type,
    p_scope: params.scope,
  });
  if (error) return { ok: false, error };

  const row = (data?.[0] ?? {}) as Record<string, unknown>;
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    ok: true,
    options: {
      practices: strings(row.practices),
      languages: strings(row.languages),
      jurisdictions: strings(row.jurisdictions),
    },
  };
}

const WORKFLOW_IDS_PAGE_SIZE = 1000;

const WORKFLOW_IDS_MAX_PAGES = 200;

export async function listWorkflowIds(
  db: Db,
  params: {
    userId: string;
    userEmail: string | undefined;
    type: string | null;
    scope: WorkflowScope;
    searchTerm: string | null;
    practice: string | null;
    language: string | null;
    jurisdiction: string | null;
  },
): Promise<
  | { ok: true; ids: { id: string; user_id: string }[] }
  | ServiceFailure
> {
  const ids: { id: string; user_id: string }[] = [];
  let offset = 0;
  for (let page = 0; page < WORKFLOW_IDS_MAX_PAGES; page += 1) {
    const rpcArgs = buildWorkflowIdsOverviewRpcArgs({
      ...params,
      pagination: { limit: WORKFLOW_IDS_PAGE_SIZE, offset },
    });
    const { data, error } = await db.rpc("get_workflow_ids_overview", rpcArgs);
    if (error) return { ok: false, error };
    const rows = (data ?? []) as { id: string; user_id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows);
    offset += rows.length;
  }
  return { ok: true, ids };
}
