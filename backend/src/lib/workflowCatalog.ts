import { selectAllByKey, selectInBatches } from "./batchedQuery";
import type { Db } from "./supabase";

export type WorkflowCatalogContributor = {
  name: string;
  organisation: string | null;
  role: string | null;
  linkedin: string | null;
};

export type WorkflowCatalogColumn = {
  index: number;
  name: string;
  format?: string;
  prompt: string;
  tags?: string[];
};

export type WorkflowCatalogRow = {
  id: string;
  workflow_key: string;
  distribution: "default" | "addon";
  version: string | null;
  title: string;
  description: string | null;
  type: "assistant" | "tabular";
  prompt_md: string | null;
  columns_config: WorkflowCatalogColumn[] | null;
  contributors: WorkflowCatalogContributor[] | null;
  language: string | null;
  practice: string | null;
  jurisdictions: string[] | null;
  pack_key: string | null;
  pack_title: string | null;
  pack_description: string | null;
  pack_version: string | null;
  source_commit: string | null;
  content_hash: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

export type LegacyCatalogWorkflow = {
  id: string;
  user_id: null;
  is_system: true;
  created_at: string;
  metadata: {
    name: string;
    title: string;
    description: string;
    type: "assistant" | "tabular";
    contributors: WorkflowCatalogContributor[];
    language: string;
    version: string;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  columns_config: WorkflowCatalogColumn[] | null;
  assets: [];
  pack: {
    key: string;
    title: string;
    description: string;
    version: string;
  } | null;
};

export function catalogWorkflowId(workflowKey: string): string {
  return `builtin-${workflowKey}`;
}

export function catalogKeyFromWorkflowId(workflowId: string): string | null {
  const match = workflowId.match(/^builtin-([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  return match?.[1] ?? null;
}

export function catalogWorkflowToLegacy(
  workflow: WorkflowCatalogRow,
): LegacyCatalogWorkflow {
  return {
    id: catalogWorkflowId(workflow.workflow_key),
    user_id: null,
    is_system: true,
    created_at: workflow.created_at,
    metadata: {
      name: workflow.workflow_key,
      title: workflow.title,
      description: workflow.description ?? "",
      type: workflow.type,
      contributors: workflow.contributors ?? [],
      language: workflow.language ?? "English",
      version: workflow.version ?? "",
      practice: workflow.practice,
      jurisdictions: workflow.jurisdictions,
    },
    skill_md: workflow.prompt_md,
    columns_config: workflow.columns_config,
    // Asset bytes live in object storage. The compatibility endpoint has
    // never been the import path; current clients use /workflow-addons.
    assets: [],
    pack: workflow.pack_key
      ? {
          key: workflow.pack_key,
          title: workflow.pack_title ?? workflow.pack_key,
          description: workflow.pack_description ?? "",
          version: workflow.pack_version ?? "",
        }
      : null,
  };
}

export async function findCatalogWorkflow(
  workflowId: string,
  db: Db,
): Promise<WorkflowCatalogRow | null> {
  const workflowKey = catalogKeyFromWorkflowId(workflowId);
  if (!workflowKey) return null;
  const { data, error } = await db
    .from("mike_workflows")
    .select("*")
    .eq("workflow_key", workflowKey)
    .order("active", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as WorkflowCatalogRow | null) ?? null;
}

export async function listActiveCatalogWorkflows(
  db: Db,
  filters: {
    type?: "assistant" | "tabular" | null;
    distribution?: "default" | "addon" | null;
  } = {},
): Promise<WorkflowCatalogRow[]> {
  let query = db.from("mike_workflows").select("*").eq("active", true);
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.distribution) {
    query = query.eq("distribution", filters.distribution);
  }
  const { data, error } = await query.order("title", { ascending: true });
  if (error) throw error;
  return (data ?? []) as WorkflowCatalogRow[];
}

type AssistantCatalogPrompt = {
  id: string;
  workflow_key: string;
  title: string;
  prompt_md: string | null;
};
const promptsByDb = new WeakMap<Db, Map<string, AssistantCatalogPrompt>>();

/** Each catalog version has a distinct id for its content hash. Read the current
 * membership each turn, then load only bodies not present in the previous catalog. */
export async function activeAssistantPrompts(db: Db): Promise<AssistantCatalogPrompt[]> {
  const active = await selectAllByKey<{ id: string }>("active assistant workflows", () =>
    db.from("mike_workflows").select("id").eq("active", true).eq("type", "assistant"),
  );
  const promptCache = promptsByDb.get(db) ?? new Map<string, AssistantCatalogPrompt>();
  const missing = active.filter(row => !promptCache.has(row.id));
  const cached = new Map(promptCache);
  const added = await selectInBatches<AssistantCatalogPrompt>(
    "assistant workflow prompts",
    missing.map(row => row.id),
    batch => db.from("mike_workflows").select("id,workflow_key,title,prompt_md").in("id", batch),
  );
  for (const row of added) cached.set(row.id, row);
  const current = active.flatMap(({ id }) => cached.get(id) ?? []);
  promptsByDb.set(db, new Map(current.map(row => [row.id, row])));
  return current;
}

// Installation markers make the database function a no-op after a user's
// first successful install. The process-local cache avoids even that RPC on
// each workflow list, Quick Action list, and chat message.
const ensuredDefaultUsers = new Set<string>();

export function resetEnsuredDefaultUsersForTests(): void {
  ensuredDefaultUsers.clear();
}

export async function ensureDefaultWorkflows(
  userId: string,
  db: Db,
): Promise<number> {
  if (ensuredDefaultUsers.has(userId)) return 0;
  const { data, error } = await db.rpc("install_missing_default_workflows", {
    p_user_id: userId,
  });
  if (error) throw error;
  ensuredDefaultUsers.add(userId);
  return typeof data === "number" ? data : 0;
}
