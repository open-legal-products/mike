import crypto from "node:crypto";
import { safeError } from "../../lib/safeError";
const { jsonrepair } = require("jsonrepair") as {
  jsonrepair: (text: string) => string;
};
import { z } from "zod";
import {
  ensureDocAccess,
  getOrgRole,
  parseContentVisibility,
  type OrgRole,
} from "../../lib/access";
import { resolveWorkspaceFilter, workspaceMatches } from "../../lib/workspace";
import type { EditAnnotation } from "@mike/contracts";
import { extractDocxBodyText, type EditInput } from "../../lib/docxTrackedChanges";
import { loadActiveVersion } from "../../lib/documentVersions";
import {
  applyTrackedEditsToDocument,
  loadCurrentVersionBytes,
} from "../documents/documents.service";
import { loadCreatorProfiles, type CreatorProfile } from "../../lib/userLookup";
import { createServerSupabase } from "../../lib/supabase";
import {
  completeText,
  streamChatWithTools,
  type NormalizedToolCall,
  type OpenAIToolSchema,
  type UserApiKeys,
} from "../../lib/llm";
import {
  builtInModelIds,
  LEGACY_MODEL_IDS,
  providerForModel,
} from "../../lib/llm/models";
import type { Provider } from "../../lib/llm/types";
import { hasApiKeyForModel } from "../../lib/modelSelection";
import { getUserApiKeys, getEffectiveApiKeys } from "../user/user.service";
import { deleteFile, downloadFile, uploadFile } from "../../lib/storage";
import { getFileStreamSource } from "../documents/documents.service";
import {
  extractPlaybookPdfStructure,
  extractPlaybookWordStructure,
  type PlaybookWordStructure,
} from "./playbooks.word";
import {
  grantedPlaybookIds,
  hasPlaybookRole,
  playbookRecipientEmails,
  resolvePlaybookRole,
  resolvePlaybookRoles,
  type PlaybookAccessRow,
  type PlaybookRole,
} from "./playbooks.access";
import { getOrgAccessOverrideRole } from "../../lib/orgAccessOverrides";
import {
  listPlaybookSourceRows,
  readPlaybookSourceText,
  type PlaybookSourceRow,
} from "./playbooks.sourceStore";

type Db = ReturnType<typeof createServerSupabase>;

const DEFAULT_PLAYBOOK_COMPILATION_TIMEOUT_MS = 300_000;
/**
 * The message stored on a failed run and returned to the browser. Provider
 * SDK exceptions, Zod dumps and database driver errors can carry API keys,
 * table names and connection details, so only messages this module wrote are
 * passed through.
 */
export function runFailureMessage(error: unknown): string {
  if (error instanceof PlaybookRequestError) return error.message;
  if (error instanceof PlaybookImportError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError")
    return "The review timed out before the model answered. Try again, or review a shorter document.";
  if (error instanceof z.ZodError)
    return "The model returned a review that did not match the expected format. Try again.";
  return "The review failed. Try again.";
}

const clauseSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  usage: z
    .enum(["illustrative", "preferred", "verbatim", "accepted", "unacceptable"])
    .default("illustrative"),
  sourceRefs: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
});

const positionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  criteria: z.string().trim().min(1).max(20_000),
  sampleClauses: z.array(clauseSchema).max(30).default([]),
});

const ruleSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(300),
  concept: z.string().trim().min(1).max(20_000),
  scope: z.enum(["clause", "agreement"]).default("clause"),
  required: z.boolean().default(false),
  guidance: z.string().trim().max(20_000).default(""),
  standard: positionSchema.nullable().default(null),
  fallbacks: z.array(positionSchema).max(20).default([]),
  unacceptable: z.array(positionSchema).max(20).default([]),
  conditions: z.array(z.string().trim().min(1).max(2_000)).max(30).default([]),
  actions: z
    .array(
      z.object({
        scenario: z.string().trim().max(2_000).default(""),
        instruction: z.string().trim().min(1).max(5_000),
      }),
    )
    .max(20)
    .default([]),
  sourceRefs: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

const topicSchema = z.object({
  id: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(300),
  rules: z.array(ruleSchema).max(200),
});

const playbookContentShape = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(""),
  representedParty: z.string().trim().max(300).default(""),
  documentTypes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  jurisdictions: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  rules: z.array(ruleSchema).max(200).default([]),
  topics: z.array(topicSchema).max(200).default([]),
});

export const playbookContentSchema = playbookContentShape.refine(
  (content) =>
    content.rules.length > 0 ||
    content.topics.some((topic) => topic.rules.length > 0),
  {
    message: "Add at least one rule before running a review.",
    path: ["rules"],
  },
);

// Autosave must accept an unfinished field or an empty topic. Compilation and
// review still use the strict schema above; structural limits apply to both.
const editableClauseSchema = clauseSchema.extend({
  text: z.string().max(20_000),
});
const editablePositionSchema = positionSchema.extend({
  name: z.string().max(200),
  criteria: z.string().max(20_000),
  sampleClauses: z.array(editableClauseSchema).max(30).default([]),
});
const editableRuleSchema = ruleSchema.extend({
  name: z.string().max(300),
  concept: z.string().max(20_000),
  guidance: z.string().max(20_000).default(""),
  standard: editablePositionSchema.nullable().default(null),
  fallbacks: z.array(editablePositionSchema).max(20).default([]),
  unacceptable: z.array(editablePositionSchema).max(20).default([]),
});
export const editablePlaybookSchema = playbookContentShape.extend({
  name: z.string().max(200),
  description: z.string().max(2_000).default(""),
  representedParty: z.string().max(300).default(""),
  rules: z.array(editableRuleSchema).max(200).default([]),
  topics: z
    .array(
      topicSchema.extend({
        name: z.string().max(300),
        rules: z.array(editableRuleSchema).max(200),
      }),
    )
    .max(200)
    .default([]),
});

const findingSchema = z.object({
  topicId: z.string().trim().max(100).nullable().default(null),
  ruleId: z.string().trim().max(100).nullable().default(null),
  ruleName: z.string().trim().min(1).max(300),
  status: z.enum([
    "not_applicable",
    "acceptable",
    "needs_review",
    "unacceptable",
    "missing_required",
    "outside_scope",
  ]),
  quote: z.string().trim().max(30_000).default(""),
  location: z.string().trim().max(500).default(""),
  analysis: z.string().trim().min(1).max(20_000),
  suggestedText: z.string().trim().max(30_000).default(""),
  /** For missing_required: the end of the clause the new one follows. */
  insertAfter: z.string().trim().max(5_000).default(""),
});

const reviewSchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  findings: z.array(findingSchema).max(1000),
});

export type PlaybookContent = z.infer<typeof playbookContentSchema>;
export type PlaybookFinding = z.infer<typeof findingSchema> & {
  id: string;
  /** The tracked change made in the reviewed document, when one was. */
  edit?: EditAnnotation | null;
};

export type Playbook = {
  id: string;
  userId: string;
  name: string;
  description: string;
  orgId: string | null;
  visibility: "private" | "organization";
  /** The caller's role: viewer (view and run), editor, or owner. */
  role: PlaybookRole;
  isCreator: boolean;
  /** Edit rules, details and sources: editor or owner. */
  canEdit: boolean;
  /** Share, change visibility and delete: owner. */
  canManageAccess: boolean;
  /** Who it is shared with, for its owners only; empty for everyone else. */
  sharedWith: string[];
  /** The creator's profile name and photo; null when they have not set one. */
  creatorName: string | null;
  creatorPhoto: string | null;
  content: PlaybookContent;
  sourceFilename: string | null;
  importModel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlaybookImportStage =
  | "validating_file"
  | "checking_model"
  | "extracting_text"
  | "compiling"
  | "validating_output"
  | "repairing_output"
  | "storing_source"
  | "saving_playbook"
  | "completed";

/**
 * A failure whose message is written for the user. The router forwards these
 * verbatim; every other error becomes a generic 500.
 */
export class PlaybookRequestError extends Error {
  readonly status: 400 | 403 | 404 | 409;

  constructor(
    message: string,
    status: 400 | 403 | 404 | 409 = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.status = status;
    this.name = "PlaybookRequestError";
  }
}

export class PlaybookImportError extends Error {
  readonly code = "PLAYBOOK_IMPORT_FAILED";

  constructor(
    message: string,
    readonly attemptId: string,
    readonly stage: PlaybookImportStage,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PlaybookImportError";
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseModelJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch {
        return JSON.parse(jsonrepair(slice));
      }
    }
    throw new PlaybookRequestError("The model did not return structured JSON.");
  }
}

function conditionObjectText(value: Record<string, unknown>): string {
  const entries = Object.entries(value).filter(
    ([, entry]) => entry !== null && entry !== undefined && entry !== "",
  );
  if (entries.length === 1 && typeof entries[0][1] === "string") {
    return entries[0][1].trim();
  }
  return entries
    .map(([key, entry]) => {
      const label = key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .replace(/^./, (character) => character.toUpperCase());
      const text =
        typeof entry === "string" ? entry.trim() : JSON.stringify(entry);
      return `${label}: ${text}`;
    })
    .join("; ");
}

export function normalizeCompiledPlaybookOutput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const playbook = value as Record<string, unknown>;
  const normalizeRules = (rules: unknown) =>
    !Array.isArray(rules)
      ? rules
      : rules.map((rule) => {
          if (!rule || typeof rule !== "object" || Array.isArray(rule))
            return rule;
          const entry = rule as Record<string, unknown>;
          if (!Array.isArray(entry.conditions)) return rule;
          return {
            ...entry,
            conditions: entry.conditions.map((condition) =>
              condition &&
              typeof condition === "object" &&
              !Array.isArray(condition)
                ? conditionObjectText(condition as Record<string, unknown>)
                : condition,
            ),
          };
        });
  return {
    ...playbook,
    rules: normalizeRules(playbook.rules),
    topics: Array.isArray(playbook.topics)
      ? playbook.topics.map((topic) => {
          if (!topic || typeof topic !== "object" || Array.isArray(topic))
            return topic;
          const entry = topic as Record<string, unknown>;
          return { ...entry, rules: normalizeRules(entry.rules) };
        })
      : playbook.topics,
  };
}

function validateCompiledPlaybookOutput(
  raw: string,
  structure: PlaybookWordStructure,
): PlaybookContent {
  return validateImportedSources(
    stableIds(
      playbookContentSchema.parse(
        normalizeCompiledPlaybookOutput(parseModelJson(raw)),
      ),
    ),
    structure,
  );
}

function validationErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

export async function validatePlaybookCompilationWithRetry(args: {
  raw: string;
  structure: PlaybookWordStructure;
  retry: (validationError: string) => Promise<string>;
}): Promise<PlaybookContent> {
  try {
    return validateCompiledPlaybookOutput(args.raw, args.structure);
  } catch (firstError) {
    const repaired = await args.retry(validationErrorMessage(firstError));
    try {
      return validateCompiledPlaybookOutput(repaired, args.structure);
    } catch (retryError) {
      throw new PlaybookRequestError(
        `The selected model returned invalid structured output twice. ${validationErrorMessage(retryError)}`,
        400,
        { cause: retryError },
      );
    }
  }
}

function stableIds(content: PlaybookContent): PlaybookContent {
  // Preserve explicit IDs where possible, and keep generated IDs from
  // colliding with IDs on later rules. Duplicate model IDs otherwise merge
  // unrelated rules in normalizeFindings and in the editor's selection.
  const reserved = new Set([
    ...content.rules.map((rule) => rule.id),
    ...content.topics.flatMap((topic) => [topic.id, ...topic.rules.map((rule) => rule.id)]),
  ].filter((id): id is string => !!id));
  const used = new Set<string>();
  function uniqueId(id: string | undefined, fallback: string) {
    if (id && !used.has(id)) {
      used.add(id);
      return id;
    }
    let candidate = fallback;
    let suffix = 2;
    while (used.has(candidate) || reserved.has(candidate)) candidate = `${fallback}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }
  return {
    ...content,
    rules: content.rules.map((rule, index) => ({
      ...rule,
      id: uniqueId(rule.id, `rule-${index + 1}`),
    })),
    topics: content.topics.map((topic, topicIndex) => ({
      ...topic,
      id: uniqueId(topic.id, `topic-${topicIndex + 1}`),
      rules: topic.rules.map((rule, ruleIndex) => ({
        ...rule,
        id: uniqueId(rule.id, `topic-${topicIndex + 1}-rule-${ruleIndex + 1}`),
      })),
    })),
  };
}

function validateImportedSources(
  content: PlaybookContent,
  structure: PlaybookWordStructure,
): PlaybookContent {
  const available = new Set(structure.sources.map((source) => source.id));
  const filter = (refs: string[]) => [
    ...new Set(refs.filter((ref) => available.has(ref))),
  ];
  const validateRule = (rule: PlaybookContent["rules"][number]) => {
    const standard = rule.standard
      ? {
          ...rule.standard,
          sampleClauses: rule.standard.sampleClauses.map((clause) => ({
            ...clause,
            sourceRefs: filter(clause.sourceRefs),
          })),
        }
      : null;
    const mapPositions = (
      positions: PlaybookContent["topics"][number]["rules"][number]["fallbacks"],
    ) =>
      positions.map((position) => ({
        ...position,
        sampleClauses: position.sampleClauses.map((clause) => ({
          ...clause,
          sourceRefs: filter(clause.sourceRefs),
        })),
      }));
    const fallbacks = mapPositions(rule.fallbacks);
    const unacceptable = mapPositions(rule.unacceptable);
    const clauseRefs = [standard, ...fallbacks, ...unacceptable]
      .filter((position): position is PlaybookPosition => !!position)
      .flatMap((position) =>
        position.sampleClauses.flatMap((clause) => clause.sourceRefs),
      );
    const sourceRefs = filter([...rule.sourceRefs, ...clauseRefs]);
    if (!sourceRefs.length) {
      throw new PlaybookRequestError(
        `The model could not tie the imported rule “${rule.name}” to the source document.`,
      );
    }
    return { ...rule, standard, fallbacks, unacceptable, sourceRefs };
  };
  return {
    ...content,
    rules: content.rules.map(validateRule),
    topics: content.topics.map((topic) => ({
      ...topic,
      rules: topic.rules.map(validateRule),
    })),
  };
}

function validateModel(model: string): void {
  if (!model.trim()) throw new PlaybookRequestError("Select a model.");
  try {
    providerForModel(model.trim());
  } catch {
    // providerForModel throws a plain Error for an unrecognised id. A stale
    // stored selection is an input problem, so answer 4xx rather than 500.
    throw new PlaybookRequestError(
      `“${model.trim()}” is not a model MikeOSS can use. Choose another model.`,
    );
  }
}

type ModelAvailability =
  { available: true } | { available: false; reason: string };

const PROVIDER_DISPLAY_NAMES: Record<Provider, string> = {
  claude: "Anthropic (Claude)",
  gemini: "Google (Gemini)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
  mistral: "Mistral AI",
  bedrock: "Amazon Bedrock",
  azure: "Azure OpenAI",
  "azure-foundry": "Azure AI Foundry",
  vertex: "Google Vertex AI",
  xai: "xAI",
  custom: "OpenAI-compatible endpoint",
  "openai-compatible": "Configured endpoint",
  ollama: "Local (Ollama)",
};

// Keyed rather than positional: a provider added later must not inherit the
// name of whichever branch happened to sit last.
function providerDisplayName(provider: Provider): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? "The selected provider";
}

export function playbookModelAvailability(
  modelId: string,
  apiKeys: UserApiKeys,
): ModelAvailability {
  let provider: Provider;
  try {
    provider = providerForModel(modelId);
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (hasApiKeyForModel(modelId, apiKeys)) return { available: true };
  return {
    available: false,
    reason: `${providerDisplayName(provider)} API key is not configured.`,
  };
}

async function assertPlaybookModelAvailable(
  userId: string,
  model: string,
  db: Db,
  orgId?: string | null,
): Promise<UserApiKeys> {
  const apiKeys = orgId
    ? await getEffectiveApiKeys(userId, orgId, db)
    : await getUserApiKeys(userId, db);
  const availability = playbookModelAvailability(model, apiKeys);
  if (!availability.available)
    throw new PlaybookRequestError(availability.reason);
  return apiKeys;
}

async function availablePlaybookModels(
  userId: string,
  db: Db,
  orgId?: string | null,
) {
  const apiKeys = orgId
    ? await getEffectiveApiKeys(userId, orgId, db)
    : await getUserApiKeys(userId, db);
  const { data: profile } = await db
    .from("user_profiles")
    .select("last_selected_chat_model, title_model, tabular_model")
    .eq("user_id", userId)
    .maybeSingle();
  // The assistant composer opens on the last model chosen there, so a
  // playbook run defaults to the same model before any background-task one.
  const profileModelIds = [
    profile?.last_selected_chat_model,
    profile?.title_model,
    profile?.tabular_model,
  ]
    .filter((modelId): modelId is string => typeof modelId === "string")
    .map((modelId) => LEGACY_MODEL_IDS[modelId] ?? modelId);
  const candidateIds = [
    ...new Set([...builtInModelIds(), ...profileModelIds]),
  ];
  const availableModelIds = candidateIds.filter(
    (modelId) => playbookModelAvailability(modelId, apiKeys).available,
  );
  const preferred = profileModelIds.find((modelId) =>
    availableModelIds.includes(modelId),
  );
  return {
    apiKeys,
    availableModelIds,
    defaultModel: preferred || availableModelIds[0] || null,
  };
}

async function updateImportAttempt(
  db: Db,
  attemptId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("playbook_imports")
    .update({
      ...values,
      updated_at: new Date().toISOString(),
    })
    .eq("id", attemptId);
  if (error) throw error;
}

/** Playbooks are prose; anything this large is not one. */
export const MAX_PLAYBOOK_IMPORT_BYTES = 25 * 1024 * 1024;

export const PLAYBOOK_IMPORT_CONTENT_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
} as const;

export type PlaybookImportFileType = keyof typeof PLAYBOOK_IMPORT_CONTENT_TYPES;

/** The kind of file a playbook can be imported from, by its name. */
export function playbookImportFileType(
  filename: string,
): PlaybookImportFileType | null {
  const extension = filename.toLowerCase().match(/\.(docx|pdf)$/)?.[1];
  return extension === "docx" || extension === "pdf" ? extension : null;
}

function importStageLabel(stage: PlaybookImportStage): string {
  return stage.replaceAll("_", " ");
}

export const PLAYBOOK_IMPORT_GENERIC_FAILURE =
  "The playbook could not be imported. Please try again.";

/**
 * The client-safe explanation for a failed import. Only messages this module
 * authored are forwarded; a storage or database exception becomes the generic
 * message so its internals never reach the browser.
 */
export function playbookImportFailureMessage(
  stage: PlaybookImportStage,
  error: unknown,
  timeoutMs = playbookCompilationTimeoutMs(),
): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  if (
    (stage === "compiling" || stage === "repairing_output") &&
    (name === "TimeoutError" ||
      /timed?\s*out|aborted due to timeout/i.test(message))
  ) {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
    return `The selected model did not finish within ${minutes} minute${minutes === 1 ? "" : "s"}. Try again or select another model.`;
  }
  if (error instanceof PlaybookRequestError) return message;
  return PLAYBOOK_IMPORT_GENERIC_FAILURE;
}

/**
 * Bound how long an import waits on a model. This stops waiting; it cannot
 * cancel the request already in flight, because completeText exposes no
 * abort signal. The name is what playbookImportFailureMessage matches on.
 */
async function withCompilationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            `The model did not respond within ${timeoutMs}ms.`,
          );
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function playbookCompilationTimeoutMs(
  configured = process.env.PLAYBOOK_COMPILATION_TIMEOUT_MS?.trim() ||
    process.env.LLM_REQUEST_TIMEOUT_MS?.trim(),
): number {
  const value = Number(configured);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_PLAYBOOK_COMPILATION_TIMEOUT_MS;
}

// Stored content that no longer satisfies the schema must not remove the
// playbook from the list: report it as empty so the row stays visible and
// can still be deleted or re-imported.
const UNREADABLE_CONTENT: PlaybookContent = {
  name: "",
  description: "",
  representedParty: "",
  documentTypes: [],
  jurisdictions: [],
  rules: [],
  topics: [],
};

function publicPlaybook(
  row: Record<string, unknown>,
  userId: string,
  creator: CreatorProfile | undefined,
  role: PlaybookRole,
  recipients: string[] = [],
): Playbook {
  const parsed = editablePlaybookSchema.safeParse(parseJson(row.content_json));
  const content = parsed.success
    ? stableIds(parsed.data)
    : { ...UNREADABLE_CONTENT, name: String(row.name ?? "") };
  const canManageAccess = role === "owner";
  return {
    id: String(row.id),
    userId: String(row.user_id),
    orgId: row.org_id ? String(row.org_id) : null,
    visibility: row.visibility === "organization" ? "organization" : "private",
    role,
    isCreator: row.user_id === userId,
    canEdit: hasPlaybookRole(role, "editor"),
    canManageAccess,
    sharedWith: canManageAccess ? recipients : [],
    name: String(row.name),
    description: String(row.description ?? ""),
    creatorName: creator?.display_name ?? null,
    creatorPhoto: creator?.profile_photo ?? null,
    content,
    sourceFilename: row.source_filename ? String(row.source_filename) : null,
    importModel: row.import_model ? String(row.import_model) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function creationScope(db: Db, userId: string, raw: unknown) {
  const result = await resolveWorkspaceFilter(db, userId, raw);
  if (!result.ok)
    throw new PlaybookRequestError(
      "Workspace not found.",
      result.kind === "validation" ? 400 : 404,
    );
  return result.workspace && result.workspace !== "personal"
    ? result.workspace
    : null;
}

export async function listPlaybooks(
  userId: string,
  db: Db = createServerSupabase(),
  options: { workspace?: unknown; email?: string | null } = {},
): Promise<Playbook[]> {
  const resolved = await resolveWorkspaceFilter(db, userId, options.workspace);
  if (!resolved.ok)
    throw new PlaybookRequestError(
      "Workspace not found.",
      resolved.kind === "validation" ? 400 : 404,
    );
  const { data: memberships, error: membershipError } = await db
    .from("org_members")
    .select("org_id, role, organizations!inner(id)")
    .is("organizations.deleted_at", null)
    .eq("user_id", userId);
  if (membershipError) throw membershipError;
  const orgRoles = new Map(
    (memberships ?? []).map((row) => [String(row.org_id), row.role as OrgRole]),
  );
  const orgIds = [...orgRoles.keys()];
  const granted = await grantedPlaybookIds(db, userId, options.email);
  const results = await Promise.all([
    db.from("playbooks").select("*").eq("user_id", userId),
    orgIds.length
      ? db
          .from("playbooks")
          .select("*")
          .eq("visibility", "organization")
          .in("org_id", orgIds)
      : { data: [], error: null },
    granted.length
      ? db.from("playbooks").select("*").in("id", granted)
      : { data: [], error: null },
  ]);
  const rows = new Map<string, Record<string, unknown>>();
  for (const result of results) {
    if (result.error) throw result.error;
    for (const row of result.data ?? []) {
      // Organization membership remains required, even for the creator.
      if (row.org_id && !orgRoles.has(row.org_id)) continue;
      if (workspaceMatches(resolved.workspace, row.org_id))
        rows.set(row.id, row);
    }
  }
  const candidates = [...rows.values()];
  const roles = await resolvePlaybookRoles(
    db,
    candidates as PlaybookAccessRow[],
    userId,
    options.email,
    orgRoles,
  );
  const visible = candidates.filter((row) => roles.has(String(row.id)));
  const [creators, recipients] = await Promise.all([
    loadCreatorProfiles(db, visible),
    playbookRecipientEmails(
      db,
      visible.filter(
        (row) => roles.get(String(row.id)) === "owner",
      ) as PlaybookAccessRow[],
    ),
  ]);
  return visible
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map((row) =>
      publicPlaybook(
        row,
        userId,
        creators.get(String(row.user_id)),
        roles.get(String(row.id))!,
        recipients.get(String(row.id)),
      ),
    );
}

/** The caller's role on a playbook, or null when they cannot open it. */
async function playbookRole(
  db: Db,
  row: Record<string, unknown>,
  userId: string,
  email: string | null | undefined,
): Promise<PlaybookRole | null> {
  const orgId = row.org_id ? String(row.org_id) : null;
  const orgRole = orgId ? await getOrgRole(userId, orgId, db) : null;
  if (orgId && !orgRole) return null;
  const isCreator = row.user_id === userId;
  let override = null;
  if (orgId && !isCreator) {
    const found = await getOrgAccessOverrideRole(
      db,
      "playbook",
      String(row.id),
      orgId,
      userId,
    );
    if (!found.ok) throw new Error(found.detail);
    override = found.role;
  }
  let directShare: PlaybookRole | null = null;
  const normalized = email?.trim().toLowerCase();
  if (!orgId && !isCreator && normalized) {
    const { data, error } = await db
      .from("playbook_shares")
      .select("role")
      .eq("playbook_id", String(row.id))
      .eq("shared_with_email", normalized)
      .maybeSingle();
    if (error) throw error;
    const role = (data as { role?: unknown } | null)?.role;
    if (role === "owner" || role === "editor" || role === "viewer")
      directShare = role;
  }
  return resolvePlaybookRole({
    isCreator,
    orgId,
    orgRole,
    visibility: row.visibility ? String(row.visibility) : null,
    override,
    directShare,
  });
}

export async function getPlaybook(
  userId: string,
  id: string,
  db: Db = createServerSupabase(),
  email?: string | null,
): Promise<Playbook> {
  const { data, error } = await db
    .from("playbooks")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Playbook not found.", 404);
  const role = await playbookRole(db, data, userId, email);
  if (!role) throw new PlaybookRequestError("Playbook not found.", 404);
  const [creators, recipients] = await Promise.all([
    loadCreatorProfiles(db, [data]),
    role === "owner"
      ? playbookRecipientEmails(db, [data as PlaybookAccessRow])
      : Promise.resolve(new Map<string, string[]>()),
  ]);
  return publicPlaybook(
    data,
    userId,
    creators.get(String(data.user_id)),
    role,
    recipients.get(String(data.id)),
  );
}

/**
 * A playbook the caller may change: rules, details and sources need Editor;
 * sharing, visibility and deletion need Owner.
 */
export async function editablePlaybook(
  userId: string,
  id: string,
  db: Db,
  email?: string | null,
  required: "editor" | "owner" = "editor",
) {
  const playbook = await getPlaybook(userId, id, db, email);
  if (!hasPlaybookRole(playbook.role, required))
    throw new PlaybookRequestError(
      required === "owner"
        ? "Only an owner of this playbook can do that."
        : "You can view this playbook but not change it.",
      403,
    );
  return playbook;
}

function compilationPrompt(
  structure: PlaybookWordStructure,
  requestedName: string,
): string {
  return `Convert the supplied human-authored legal playbook into structured rules. Preserve concepts and sample clauses; do not invent policy. A source marker such as [P4] or [T2R3C1] identifies the exact paragraph or table cell. Every rule and sample clause must cite the relevant sourceRefs.

Rules may contain a standard position, fallback positions, unacceptable positions, guidance, conditions, and escalation actions. A position can be a concept or exact language. Mark sample clause usage as illustrative, preferred, verbatim, accepted, or unacceptable. Use verbatim only when the source clearly requires exact wording. If a clause must be present, set required true. Keep uncertain material in guidance rather than guessing.

The conditions field must always be an array of plain JSON strings, for example ["Applies when annual fees exceed $100,000"]. Never put objects, arrays, numbers, or booleans inside conditions. Express each condition as one readable sentence. Only actions may contain objects, and every action object must contain string fields named scenario and instruction.

Return JSON only with this shape:
{"name":"${requestedName.replace(/["\\]/g, "")}","description":"","representedParty":"","documentTypes":[],"jurisdictions":[],"topics":[{"id":"topic-1","name":"","rules":[{"id":"topic-1-rule-1","name":"","concept":"","scope":"clause|agreement","required":false,"guidance":"","standard":{"name":"Standard","criteria":"","sampleClauses":[{"text":"","usage":"illustrative|preferred|verbatim|accepted|unacceptable","sourceRefs":["P1"]}]}|null,"fallbacks":[],"unacceptable":[],"conditions":[],"actions":[{"scenario":"","instruction":""}],"sourceRefs":["P1"]}]}]}

SOURCE PLAYBOOK:
${structure.text.slice(0, 150_000)}`;
}

function compilationRetryPrompt(
  structure: PlaybookWordStructure,
  requestedName: string,
  validationError: string,
): string {
  return `${compilationPrompt(structure, requestedName)}

RETRY REQUIREMENT:
The previous response could not be imported for this reason:
${validationError}

Recompile the source from the beginning. Start the response with { and end it with }. Return one complete JSON object only; do not include analysis, commentary, or Markdown fences.`;
}

/** Callers authorize first; an editor may replace someone else's playbook. */
async function playbookSourceStorageKey(
  db: Db,
  playbookId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("playbooks")
    .select("source_storage_key")
    .eq("id", playbookId)
    .maybeSingle();
  if (error) throw error;
  return data?.source_storage_key ? String(data.source_storage_key) : null;
}

/** How often a compiling import records that its process is still at it. */
const IMPORT_HEARTBEAT_MS = 30_000;
/** A running import silent for this long stopped with its process. */
const IMPORT_STALE_MS = 2 * 60_000;
export const INTERRUPTED_IMPORT_ERROR =
  "The import stopped before it finished. Import the playbook again.";

/** An import attempt as the page follows it. */
export type PlaybookImport = {
  id: string;
  status: "running" | "completed" | "failed";
  stage: string;
  error: string | null;
  filename: string;
  name: string | null;
  /** The playbook being replaced, or the one created once completed. */
  playbookId: string | null;
  startedAt: string;
  completedAt: string | null;
};

/**
 * An import's state as readers should see it. An import compiles in the
 * process that started it, so one whose heartbeat has stopped will never
 * finish.
 */
function publicImport(
  row: Record<string, unknown>,
  now = Date.now(),
): PlaybookImport {
  const lastSeen = Date.parse(String(row.updated_at ?? row.started_at));
  const interrupted =
    row.status === "running" &&
    Number.isFinite(lastSeen) &&
    now - lastSeen > IMPORT_STALE_MS;
  const status = interrupted ? "failed" : String(row.status);
  return {
    id: String(row.id),
    status:
      status === "completed" || status === "failed" ? status : "running",
    stage: String(row.stage),
    error: interrupted
      ? INTERRUPTED_IMPORT_ERROR
      : row.error
        ? String(row.error)
        : null,
    filename: String(row.filename),
    name: row.requested_name ? String(row.requested_name) : null,
    playbookId: row.playbook_id ? String(row.playbook_id) : null,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

const IMPORT_COLUMNS =
  "id, status, stage, error, filename, requested_name, playbook_id, started_at, completed_at, updated_at";

/** One of the caller's import attempts. */
export async function getPlaybookImport(
  userId: string,
  importId: string,
  db: Db = createServerSupabase(),
): Promise<PlaybookImport> {
  const { data, error } = await db
    .from("playbook_imports")
    .select(IMPORT_COLUMNS)
    .eq("id", importId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Import not found.", 404);
  return publicImport(data as Record<string, unknown>);
}

/**
 * The caller's imports still compiling in a workspace, newest first, so a
 * page opened later can follow them.
 */
export async function listRunningPlaybookImports(
  userId: string,
  db: Db = createServerSupabase(),
  workspace?: unknown,
): Promise<PlaybookImport[]> {
  const orgId = await creationScope(db, userId, workspace);
  const query = db
    .from("playbook_imports")
    .select(IMPORT_COLUMNS)
    .eq("user_id", userId)
    .eq("status", "running");
  const { data, error } = await (orgId
    ? query.eq("org_id", orgId)
    : query.is("org_id", null)
  )
    .order("started_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[])
    .map((row) => publicImport(row))
    .filter((attempt) => attempt.status === "running");
}

type PlaybookImportArgs = {
  userId: string;
  /** Needed to replace a personal playbook shared with the caller. */
  userEmail?: string | null;
  filename: string;
  buffer: Buffer;
  name?: string;
  workspace?: unknown;
  model: string;
  /** Replace this playbook's content instead of creating a new playbook. */
  playbookId?: string;
  db?: Db;
  dependencies?: {
    completeText?: typeof completeText;
  };
};

/**
 * Compile a playbook from a document already in the caller's files, as
 * startPlaybookImport does from an upload. The playbook keeps its own copy
 * of the file, so later changes to the document do not reach it.
 */
export async function startPlaybookImportFromDocument(
  args: Omit<PlaybookImportArgs, "filename" | "buffer"> & {
    documentId: string;
  },
) {
  const db = args.db ?? createServerSupabase();
  const source = await getFileStreamSource(
    args.documentId,
    args.userId,
    args.userEmail ?? undefined,
    null,
    db,
  );
  if (!source.ok) throw new PlaybookRequestError("Document not found.", 404);
  if (source.size > MAX_PLAYBOOK_IMPORT_BYTES)
    throw new PlaybookRequestError("The document is too large to import.");
  const bytes = await downloadFile(source.storagePath);
  if (!bytes) throw new PlaybookRequestError("The document could not be read.");
  return startPlaybookImport({
    ...args,
    db,
    filename: source.filename,
    buffer: Buffer.from(bytes),
  });
}

/** Starts an import and waits for it: for callers that need the playbook. */
export async function importPlaybookFromFile(
  args: PlaybookImportArgs,
): Promise<Playbook> {
  const { done } = await startPlaybookImport(args);
  return done;
}

/**
 * Checks and records an import, then compiles it apart from the request: the
 * attempt is returned once the file, target, and model are known to be
 * usable, and `done` settles when the playbook is saved. Leaving the page
 * detaches from the import without stopping it; its row says how it went.
 */
export async function startPlaybookImport(
  args: PlaybookImportArgs,
): Promise<{ attempt: PlaybookImport; done: Promise<Playbook> }> {
  const db = args.db ?? createServerSupabase();
  const now = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const model = args.model.trim();
  const compilationTimeoutMs = playbookCompilationTimeoutMs();
  let stage: PlaybookImportStage = "validating_file";
  let uploadedStorageKey: string | null = null;
  const row = {
    id: attemptId,
    user_id: args.userId,
    filename: args.filename,
    requested_name: args.name?.trim() || null,
    model,
    status: "running",
    stage,
    error: null,
    playbook_id: args.playbookId ?? null,
    org_id: null as string | null,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };
  const attempt = await db.from("playbook_imports").insert(row);
  if (attempt.error) throw attempt.error;

  async function failed(error: unknown): Promise<PlaybookImportError> {
    console.error("[playbooks] import failed", { attemptId, stage, error: safeError(error) });
    const message = playbookImportFailureMessage(
      stage,
      error,
      compilationTimeoutMs,
    );
    const completedAt = new Date().toISOString();
    if (uploadedStorageKey) {
      await deleteFile(uploadedStorageKey).catch(() => {});
    }
    try {
      await updateImportAttempt(db, attemptId, {
        status: "failed",
        stage,
        error: message,
        completed_at: completedAt,
      });
    } catch (auditError) {
      console.error("[playbooks] failed to record import failure", {
        attemptId,
        error: safeError(auditError),
      });
    }
    return new PlaybookImportError(
      `Playbook import failed during ${importStageLabel(stage)}: ${message}`,
      attemptId,
      stage,
      { cause: error },
    );
  }

  // Everything that can be refused without the model is refused here, so the
  // request that starts the import reports it.
  let fileType: PlaybookImportFileType;
  let replacing: Awaited<ReturnType<typeof editablePlaybook>> | null;
  let orgId: string | null;
  let apiKeys: UserApiKeys;
  try {
    const type = playbookImportFileType(args.filename);
    if (!type)
      throw new PlaybookRequestError(
        "Playbook import requires a .docx or .pdf file.",
      );
    fileType = type;
    if (!args.buffer.length)
      throw new PlaybookRequestError("The uploaded playbook is empty.");

    // Resolve the replace target first. An unknown or unowned playbook must
    // fail before the import spends a model call on it.
    replacing = args.playbookId
      ? await editablePlaybook(args.userId, args.playbookId, db, args.userEmail)
      : null;

    orgId = replacing
      ? replacing.orgId
      : await creationScope(db, args.userId, args.workspace);
    row.org_id = orgId;

    stage = "checking_model";
    await updateImportAttempt(db, attemptId, { stage, org_id: orgId });
    validateModel(model);
    apiKeys = await assertPlaybookModelAvailable(
      args.userId,
      model,
      db,
      orgId,
    );
  } catch (error) {
    throw await failed(error);
  }

  async function compile(): Promise<Playbook> {
    const heartbeat = setInterval(() => {
      void db
        .from("playbook_imports")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", attemptId)
        .eq("status", "running")
        .then(({ error }) => {
          if (error)
            console.error("[playbooks] import heartbeat failed", {
              attemptId,
              error: safeError(error),
            });
        });
    }, IMPORT_HEARTBEAT_MS);
    heartbeat.unref?.();
    try {
      stage = "extracting_text";
      await updateImportAttempt(db, attemptId, { stage });
      const structure =
        fileType === "pdf"
          ? await extractPlaybookPdfStructure(args.buffer)
          : await extractPlaybookWordStructure(args.buffer);
      if (!structure.text) {
        throw new PlaybookRequestError(
          "This PDF has no text layer, so its content cannot be read. It is most likely scanned and needs OCR before it can be imported.",
        );
      }
      if (structure.text.length > 150_000) {
        throw new PlaybookRequestError(
          "The playbook is too large to compile in one pass. Split it into smaller playbooks before importing.",
        );
      }
      const fallbackName =
        args.filename.replace(/\.(docx|pdf)$/i, "").trim() || "Imported playbook";
      const name = args.name?.trim() || replacing?.name || fallbackName;

      stage = "compiling";
      await updateImportAttempt(db, attemptId, { stage });
      const runCompletion = args.dependencies?.completeText ?? completeText;
      const raw = await withCompilationTimeout(
        runCompletion({
          model,
          systemPrompt:
            "You compile legal playbooks into auditable structured data. Return only valid JSON and never add legal positions absent from the source.",
          user: compilationPrompt(structure, name),
          maxTokens: 16_000,
          apiKeys,
        }),
        compilationTimeoutMs,
      );

      stage = "validating_output";
      await updateImportAttempt(db, attemptId, { stage });
      const content = await validatePlaybookCompilationWithRetry({
        raw,
        structure,
        retry: async (validationError) => {
          stage = "repairing_output";
          await updateImportAttempt(db, attemptId, { stage });
          const retried = await withCompilationTimeout(
            runCompletion({
              model,
              systemPrompt:
                "You compile legal playbooks into auditable structured data. Your previous response failed validation. Return exactly one complete valid JSON object and no other text.",
              user: compilationRetryPrompt(structure, name, validationError),
              maxTokens: 16_000,
              apiKeys,
            }),
            compilationTimeoutMs,
          );
          stage = "validating_output";
          await updateImportAttempt(db, attemptId, { stage });
          return retried;
        },
      });
      const id = replacing?.id ?? crypto.randomUUID();
      // The key carries the attempt id so a replacement never overwrites the
      // current source before its row update commits.
      // Under the creator's prefix, whoever replaces it.
      const storageKey = `playbooks/${replacing?.userId ?? args.userId}/${id}/source-${attemptId}.${fileType}`;
      const previousStorageKey = replacing
        ? await playbookSourceStorageKey(db, id)
        : null;

      stage = "storing_source";
      await updateImportAttempt(db, attemptId, { stage });
      await uploadFile(
        storageKey,
        args.buffer.buffer.slice(
          args.buffer.byteOffset,
          args.buffer.byteOffset + args.buffer.byteLength,
        ) as ArrayBuffer,
        PLAYBOOK_IMPORT_CONTENT_TYPES[fileType],
      );
      uploadedStorageKey = storageKey;

      stage = "saving_playbook";
      await updateImportAttempt(db, attemptId, { stage });
      // Review runs retain their own content snapshot when the source changes.
      const { error } = replacing
        ? await db
            .from("playbooks")
            .update({
              name: content.name,
              description: content.description,
              content_json: content,
              source_filename: args.filename,
              source_storage_key: storageKey,
              import_model: model,
              updated_at: new Date().toISOString(),
            })
            .eq("id", id)
        : await db.from("playbooks").insert({
            id,
            user_id: args.userId,
            name: content.name,
            description: content.description,
            content_json: content,
            org_id: orgId,
            source_filename: args.filename,
            source_storage_key: storageKey,
            import_model: model,
            created_at: now,
            updated_at: now,
          });
      if (error) {
        await deleteFile(storageKey).catch(() => {});
        uploadedStorageKey = null;
        throw error;
      }
      uploadedStorageKey = null;
      // The row now points at the new object, so the superseded one is safe to
      // remove. Losing this cleanup must not fail the import.
      if (previousStorageKey && previousStorageKey !== storageKey)
        await deleteFile(previousStorageKey).catch((cleanupError) => {
          console.error("[playbooks] replaced source cleanup failed", {
            storageKey: previousStorageKey,
            error: safeError(cleanupError),
          });
        });

      stage = "completed";
      const completedAt = new Date().toISOString();
      try {
        await updateImportAttempt(db, attemptId, {
          status: "completed",
          stage,
          playbook_id: id,
          completed_at: completedAt,
        });
      } catch (auditError) {
        console.error("[playbooks] failed to complete import audit record", {
          attemptId,
          playbookId: id,
          error: safeError(auditError),
        });
      }
      return getPlaybook(args.userId, id, db, args.userEmail);
    } catch (error) {
      throw await failed(error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  return {
    attempt: publicImport({ ...row, stage }),
    done: compile(),
  };
}

/**
 * Every rule needs a concept: the review model has nothing to look for
 * without one, and the schema requires it. A new rule therefore starts with
 * placeholder text the author replaces, not an empty string.
 */
export const BLANK_RULE_CONCEPT =
  "Describe the contract term this rule looks for.";

const newPlaybookDetailsSchema = playbookContentShape.pick({
  description: true,
  representedParty: true,
  documentTypes: true,
  jurisdictions: true,
});
type NewPlaybookDetails = z.infer<typeof newPlaybookDetailsSchema>;

export function blankPlaybookContent(
  name: string,
  details: Partial<NewPlaybookDetails> = {},
): PlaybookContent {
  return playbookContentSchema.parse({
    ...details,
    name,
    rules: [
      {
        id: "rule-1",
        name: "New rule",
        concept: BLANK_RULE_CONCEPT,
      },
    ],
  });
}

/**
 * Start a playbook without a Word source. The editor supports authoring a
 * playbook by hand, so importing a .docx must not be the only way to get a
 * first playbook. A hand-authored rule carries no sourceRefs; the strict
 * source check applies to compiled imports only.
 */
export async function createPlaybook(
  userId: string,
  rawDetails: string | Record<string, unknown> | undefined,
  db: Db = createServerSupabase(),
  workspace?: unknown,
  rawVisibility?: unknown,
): Promise<Playbook> {
  const orgId = await creationScope(db, userId, workspace);
  const visibility = parseContentVisibility(rawVisibility, orgId);
  if (!visibility.ok) throw new PlaybookRequestError(visibility.detail);
  const input =
    typeof rawDetails === "string" ? { name: rawDetails } : (rawDetails ?? {});
  const name =
    (typeof input.name === "string" && input.name.trim()) ||
    "Untitled playbook";
  if (name.length > 200)
    throw new PlaybookRequestError("The playbook name is too long.");
  const details = newPlaybookDetailsSchema.safeParse(input);
  if (!details.success)
    throw new PlaybookRequestError(
      "The playbook contains an invalid field or exceeds a field limit.",
    );
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const content = blankPlaybookContent(name, details.data);
  const { error } = await db.from("playbooks").insert({
    id,
    user_id: userId,
    name: content.name,
    description: content.description,
    content_json: content,
    org_id: orgId,
    // Absent keeps the column's default: private.
    ...(visibility.visibility ? { visibility: visibility.visibility } : {}),
    source_filename: null,
    source_storage_key: null,
    import_model: null,
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;
  return getPlaybook(userId, id, db);
}

export async function updatePlaybookContent(
  userId: string,
  id: string,
  raw: unknown,
  db: Db = createServerSupabase(),
  access: { visibility?: unknown } = {},
  email?: string | null,
): Promise<Playbook> {
  const playbook = await editablePlaybook(userId, id, db, email);
  const parsed = editablePlaybookSchema.safeParse(raw);
  if (!parsed.success)
    throw new PlaybookRequestError(
      "The playbook contains an invalid field or exceeds a field limit.",
    );
  const content = stableIds(parsed.data);
  const visibility = parseContentVisibility(access.visibility, playbook.orgId);
  if (!visibility.ok) throw new PlaybookRequestError(visibility.detail);
  const updates: Record<string, unknown> = {
    name: content.name.trim() || "Untitled playbook",
    description: content.description,
    content_json: content,
    updated_at: new Date().toISOString(),
  };
  if (
    visibility.visibility &&
    visibility.visibility !== playbook.visibility
  ) {
    // Opening a playbook to the organization, or closing it, is an access
    // change like any other share.
    if (!playbook.canManageAccess)
      throw new PlaybookRequestError(
        "Only an owner of this playbook can change who can open it.",
        403,
      );
    updates.visibility = visibility.visibility;
  }
  // Access was checked above, for this caller's role; an editor writes to a
  // playbook they did not create.
  const { error } = await db.from("playbooks").update(updates).eq("id", id);
  if (error) throw error;
  return getPlaybook(userId, id, db, email);
}

const READ_SOURCE_TOOL: OpenAIToolSchema = {
  type: "function",
  function: {
    name: "read_supplementary_document",
    description:
      "Read the text of one of the playbook's supplementary documents. Long documents come back in pieces; pass the offset from the previous result to continue.",
    parameters: {
      type: "object",
      properties: {
        documentId: {
          type: "string",
          description: "An id from the SUPPLEMENTARY DOCUMENTS list.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to continue from. Omit to start at the beginning.",
        },
      },
      required: ["documentId"],
    },
  },
};

const REVIEW_SYSTEM_PROMPT =
  "You are a cautious contract review system. Apply only the supplied playbook and return auditable JSON.";

/** The documents a review can read on request; their text is not included. */
function supplementaryDocumentList(sources: PlaybookSourceRow[]): string {
  if (!sources.length) return "";
  return `SUPPLEMENTARY DOCUMENTS
The playbook may refer to these documents. Their text is not included here. When a rule, guidance, or instruction depends on one, call ${READ_SOURCE_TOOL.function.name} with its id and read it before deciding. Do not read documents the review does not need.
${sources
  .map(
    (source) =>
      `- id: ${source.id} | name: ${source.filename} | ${source.textLength} characters`,
  )
  .join("\n")}

`;
}

/** Statuses a review reports when its scope is issues only. */
const ISSUE_STATUSES = new Set<PlaybookFinding["status"]>([
  "unacceptable",
  "missing_required",
  "needs_review",
]);

function reviewPrompt(
  content: PlaybookContent,
  documentText: string,
  mode: "strict" | "permissive",
  instructions?: string,
  sources: PlaybookSourceRow[] = [],
  scope: "full" | "issues" = "full",
): string {
  return `Review the full contract against the playbook. Apply unacceptable positions first. In strict mode, fallback matches still need review. In permissive mode, a fallback may be acceptable but explain which fallback applies. Flag a missing required rule as missing_required. Use not_applicable only when an optional concept is absent. Quote exact contract text so Word can locate it. suggestedText must be a complete replacement for quote, or the complete clause to insert for missing_required. For missing_required, set insertAfter to the exact final words (up to 200 characters) of the existing clause the new clause should follow, or leave it empty if no clause fits. Do not suggest an edit for acceptable or not_applicable findings. Do not invent contract language or findings.

${instructions?.trim() ? `ADDITIONAL REVIEW INSTRUCTIONS:\n${instructions.trim().slice(0, 8_000)}\n` : ""}

Return JSON only:
{"summary":"","findings":[{"topicId":"topic-1|null","ruleId":"topic-1-rule-1|null","ruleName":"","status":"not_applicable|acceptable|needs_review|unacceptable|missing_required|outside_scope","quote":"exact contract text or empty when missing","location":"section or heading","analysis":"","suggestedText":"","insertAfter":"exact contract text, only for missing_required"}]}

REVIEW MODE: ${mode}
${scope === "issues" ? "REVIEW SCOPE: issues only. Report only rules whose status is unacceptable, missing_required, or needs_review; leave acceptable, not_applicable, and outside_scope rules out of findings, and summarise the issues.\n" : ""}${supplementaryDocumentList(sources)}PLAYBOOK:
${JSON.stringify(content).slice(0, 100_000)}

CONTRACT:
${documentText.slice(0, 180_000)}`;
}

type PlaybookPosition =
  PlaybookContent["topics"][number]["rules"][number]["fallbacks"][number];

function actualDocumentQuote(
  documentText: string,
  proposed: string | undefined,
): string {
  const quote = (proposed ?? "").trim();
  if (!quote) return "";
  if (documentText.includes(quote)) return quote;
  const parts = quote.split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const pattern = parts
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  try {
    return documentText.match(new RegExp(pattern, "i"))?.[0] ?? "";
  } catch {
    return "";
  }
}

export function normalizeFindings(
  content: PlaybookContent,
  documentText: string,
  findings: z.infer<typeof findingSchema>[],
  /**
   * A full review flags every rule the model skipped. An issues-only review
   * leaves acceptable rules out on purpose, so they must not be flagged.
   */
  options: { flagMissingRules?: boolean } = {},
): PlaybookFinding[] {
  const rules = new Map<string, { topicId: string | null; name: string }>();
  // The prompt allows a null ruleId, and models commonly identify a rule by
  // name instead. Without this index that answer would be discarded and the
  // rule back-filled as "the model did not return a result" — the opposite of
  // what happened.
  const ruleIdByName = new Map<string, string>();
  for (const topic of [{ id: null, rules: content.rules }, ...content.topics]) {
    for (const rule of topic.rules) {
      rules.set(rule.id!, { topicId: topic.id ?? null, name: rule.name });
      const key = rule.name.trim().toLowerCase();
      // Ambiguous names must not be guessed at.
      ruleIdByName.set(key, ruleIdByName.has(key) ? "" : rule.id!);
    }
  }
  const seen = new Set<string>();
  const normalized: PlaybookFinding[] = [];
  for (const finding of findings) {
    if (finding.status === "outside_scope") {
      normalized.push({
        ...finding,
        id: crypto.randomUUID(),
        topicId: null,
        ruleId: null,
        quote: actualDocumentQuote(documentText, finding.quote),
        insertAfter: actualDocumentQuote(documentText, finding.insertAfter),
      });
      continue;
    }
    const ruleId =
      finding.ruleId && rules.has(finding.ruleId)
        ? finding.ruleId
        : ruleIdByName.get(finding.ruleName.trim().toLowerCase()) || null;
    const rule = ruleId ? rules.get(ruleId) : null;
    if (!rule || !ruleId || seen.has(ruleId)) continue;
    seen.add(ruleId);
    normalized.push({
      ...finding,
      id: crypto.randomUUID(),
      topicId: rule.topicId,
      ruleId,
      ruleName: rule.name,
      quote: actualDocumentQuote(documentText, finding.quote),
      insertAfter: actualDocumentQuote(documentText, finding.insertAfter),
    });
  }
  for (const [ruleId, rule] of rules) {
    if (seen.has(ruleId) || options.flagMissingRules === false) continue;
    normalized.push({
      id: crypto.randomUUID(),
      topicId: rule.topicId,
      ruleId,
      ruleName: rule.name,
      status: "needs_review",
      quote: "",
      location: "",
      suggestedText: "",
      insertAfter: "",
      analysis:
        "The model did not return a result for this rule. Review it manually before completing the playbook review.",
    });
  }
  return normalized;
}

/**
 * The text of a stored document to review. A Word document is read from its
 * current file with the same extraction the tracked-change matcher uses, so
 * quoted text can be located again when its edits are applied.
 */
async function loadReviewDocument(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  documentId: string,
) {
  const missing = () => new PlaybookRequestError("Document not found.", 404);
  const { data: doc, error } = await db
    .from("documents")
    .select("id, user_id, project_id, org_id, workflow_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!doc) throw missing();
  const access = await ensureDocAccess(doc, userId, userEmail, db);
  if (!access.ok) throw missing();
  const version = await loadActiveVersion(documentId, db);
  if (!version) throw missing();
  const filename = version.filename?.trim() || "Untitled document";
  const isDocx = version.file_type === "docx" || /\.docx$/i.test(filename);
  if (!isDocx) return { filename, isDocx, text: null };
  const current = await loadCurrentVersionBytes(documentId, db, version.id);
  if (!current) throw missing();
  return {
    filename, isDocx, text: await extractDocxBodyText(current.bytes),
    version: { id: version.id, storagePath: current.storage_path },
  };
}

/**
 * Applies each finding's suggested language to the reviewed document as one
 * set of tracked changes, and links every change to its finding. A finding
 * whose text cannot be located keeps its suggestion as text.
 */
async function applyReviewEdits(args: {
  db: Db;
  userId: string;
  userEmail?: string | null;
  documentId: string;
  expectedVersion: { id: string; storagePath: string };
  findings: PlaybookFinding[];
}): Promise<{
  findings: PlaybookFinding[];
  version: { id: string; number: number; downloadUrl: string } | null;
}> {
  const planned: { index: number; edit: EditInput }[] = [];
  args.findings.forEach((finding, index) => {
    const suggestion = finding.suggestedText.trim();
    if (!suggestion) return;
    if (finding.status === "missing_required") {
      // A missing clause is inserted after the clause the model named.
      if (!finding.insertAfter) return;
      planned.push({
        index,
        edit: {
          find: finding.insertAfter,
          replace: `${finding.insertAfter}\n\n${suggestion}`,
          context_before: "",
          context_after: "",
          reason: finding.ruleName,
        },
      });
    } else if (
      finding.quote &&
      finding.quote !== suggestion &&
      (finding.status === "unacceptable" || finding.status === "needs_review")
    ) {
      planned.push({
        index,
        edit: {
          find: finding.quote,
          replace: suggestion,
          context_before: "",
          context_after: "",
          reason: finding.ruleName,
        },
      });
    }
  });
  if (!planned.length) return { findings: args.findings, version: null };
  const result = await applyTrackedEditsToDocument({
    documentId: args.documentId,
    userId: args.userId,
    userEmail: args.userEmail,
    expectedVersion: args.expectedVersion,
    edits: planned.map((item) => item.edit),
    db: args.db,
  });
  // A reader who cannot edit, or text that cannot be found, keeps the review
  // as text alone.
  if (!result.ok) return { findings: args.findings, version: null };
  const failed = new Set(result.errors.map((error) => error.index));
  const applied = planned.filter((_, index) => !failed.has(index));
  const findings = [...args.findings];
  // Each applied edit yields one change, in order; without that guarantee the
  // changes stay in the document but are not tied to findings.
  if (applied.length === result.annotations.length)
    applied.forEach((item, position) => {
      findings[item.index] = {
        ...findings[item.index],
        edit: result.annotations[position],
      };
    });
  return {
    findings,
    version: {
      id: result.version_id,
      number: result.version_number,
      downloadUrl: result.download_url,
    },
  };
}

/** How often a running review records that its process is still at it. */
const RUN_HEARTBEAT_MS = 30_000;
/** A running review silent for this long stopped with its process. */
const RUN_STALE_MS = 2 * 60_000;
export const INTERRUPTED_RUN_ERROR =
  "The review stopped before it finished. Run it again.";

/**
 * A run's status as readers should see it. A review runs in the process that
 * started it, so one whose heartbeat has stopped will never finish.
 */
function runState(row: Record<string, unknown>, now = Date.now()) {
  const lastSeen = Date.parse(String(row.updated_at ?? row.started_at));
  const interrupted =
    row.status === "running" &&
    Number.isFinite(lastSeen) &&
    now - lastSeen > RUN_STALE_MS;
  return {
    status: interrupted ? "failed" : String(row.status),
    error: interrupted
      ? INTERRUPTED_RUN_ERROR
      : row.error
        ? String(row.error)
        : null,
  };
}

/** Starts a review and waits for it: for callers that need the findings. */
export async function reviewWithPlaybook(
  args: Parameters<typeof startPlaybookReview>[0],
) {
  const { done } = await startPlaybookReview(args);
  return done;
}

/**
 * Checks and records a review, then runs it apart from the request: the run
 * is returned as soon as it is stored, and `done` settles when it finishes.
 * Leaving the page detaches from the review without stopping it; its row says
 * how it went.
 */
export async function startPlaybookReview(args: {
  userId: string;
  userEmail?: string | null;
  playbookId: string;
  /** Text extracted by the caller; a stored Word document is read instead. */
  documentText?: string;
  documentName?: string;
  /** A stored document to review; a Word document also gets tracked changes. */
  documentId?: string;
  instructions?: string;
  model: string;
  reviewMode: "strict" | "permissive";
  /** "issues" reports only what needs attention; the run records which. */
  reviewScope?: "full" | "issues";
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  validateModel(args.model);
  const stored = args.documentId
    ? await loadReviewDocument(db, args.userId, args.userEmail, args.documentId)
    : null;
  const documentText = stored?.text ?? args.documentText ?? "";
  const documentName = args.documentName?.trim() || stored?.filename;
  if (!documentText.trim())
    throw new PlaybookRequestError("Document text is required.");
  if (documentText.length > 180_000)

    throw new PlaybookRequestError(
      "The document is too large for a complete playbook review. Review a shorter document or selected sections.",
    );
  const playbook = await getPlaybook(
    args.userId,
    args.playbookId,
    db,
    args.userEmail,
  );
  const parsedContent = playbookContentSchema.safeParse(playbook.content);
  if (!parsedContent.success)
    throw new PlaybookRequestError(
      "Complete the playbook name, rules, and positions before running a review.",
    );
  const content = stableIds(parsedContent.data);
  const apiKeys = await assertPlaybookModelAvailable(
    args.userId,
    args.model,
    db,
    playbook.orgId,
  );
  if (JSON.stringify(content).length > 100_000)
    throw new PlaybookRequestError(
      "The playbook is too large for a complete review. Split it into smaller playbooks.",
    );
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const row = {
    id: runId,
    playbook_id: args.playbookId,
    content_json: content,
    user_id: args.userId,
    model: args.model,
    document_name: documentName || null,
    document_id: args.documentId ?? null,
    edited_version_id: null,
    review_mode: args.reviewMode,
    review_scope: args.reviewScope ?? "full",
    status: "running",
    summary: null,
    findings_json: [],
    error: null,
    started_at: startedAt,
    completed_at: null,
    created_at: startedAt,
    updated_at: startedAt,
  };
  const inserted = await db.from("playbook_runs").insert(row);
  if (inserted.error) throw inserted.error;
  const done = runReview({
    db,
    args,
    runId,
    startedAt,
    content,
    documentText,
    documentName,
    stored,
    apiKeys,
  });
  return { run: publicRun(row), done };
}

async function runReview({
  db,
  args,
  runId,
  startedAt,
  content,
  documentText,
  documentName,
  stored,
  apiKeys,
}: {
  db: Db;
  args: Parameters<typeof startPlaybookReview>[0];
  runId: string;
  startedAt: string;
  content: PlaybookContent;
  documentText: string;
  documentName: string | undefined;
  stored: Awaited<ReturnType<typeof loadReviewDocument>> | null;
  apiKeys: UserApiKeys;
}) {
  const heartbeat = setInterval(() => {
    void db
      .from("playbook_runs")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", runId)
      .eq("status", "running")
      .then(({ error }) => {
        if (error)
          console.error("[playbooks] review heartbeat failed", {
            runId,
            error: safeError(error),
          });
      });
  }, RUN_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const sources = await listPlaybookSourceRows(db, args.playbookId);
    const scope = args.reviewScope ?? "full";
    const prompt = reviewPrompt(
      content,
      documentText,
      args.reviewMode,
      args.instructions,
      sources,
      scope,
    );
    const raw = sources.length
      ? await completeReviewWithSources({
          db,
          playbookId: args.playbookId,
          model: args.model,
          apiKeys,
          prompt,
          sources,
        })
      : await completeText({
          model: args.model,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          user: prompt,
          maxTokens: 20_000,
          apiKeys,
        });
    const parsed = reviewSchema.parse(parseModelJson(raw));
    const normalized = normalizeFindings(
      content,
      documentText,
      parsed.findings,
      { flagMissingRules: scope === "full" },
    );
    // Held to the scope even if the model reports more.
    const reviewed =
      scope === "issues"
        ? normalized.filter((finding) => ISSUE_STATUSES.has(finding.status))
        : normalized;
    const { findings, version } =
      args.documentId && stored?.version
        ? await applyReviewEdits({
            db,
            userId: args.userId,
            userEmail: args.userEmail,
            documentId: args.documentId,
            expectedVersion: stored.version,
            findings: reviewed,
          })
        : { findings: reviewed, version: null };
    const versionId = version?.id ?? null;
    const completedAt = new Date().toISOString();
    const updated = await db
      .from("playbook_runs")
      .update({
        status: "completed",
        summary: parsed.summary,
        findings_json: findings,
        edited_version_id: versionId,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq("id", runId)
      .eq("user_id", args.userId);
    if (updated.error) throw updated.error;
    return {
      id: runId,
      playbookId: args.playbookId,
      model: args.model,
      documentName: documentName ?? null,
      documentId: args.documentId ?? null,
      editedVersionId: versionId,
      /** For the response that made them; a stored run has only the id. */
      editedVersionNumber: version?.number ?? null,
      editedDownloadUrl: version?.downloadUrl ?? null,
      reviewMode: args.reviewMode,
      reviewScope: scope,
      status: "completed" as const,
      summary: parsed.summary,
      findings,
      error: null,
      startedAt,
      completedAt,
    };
  } catch (error) {
    console.error("[playbooks] review failed", { runId, error: safeError(error) });
    const completedAt = new Date().toISOString();
    await db
      .from("playbook_runs")
      .update({
        status: "failed",
        error: runFailureMessage(error),
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq("id", runId)
      .eq("user_id", args.userId);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * A review that can read the playbook's supplementary documents through a
 * tool call. Nothing is read unless the model asks for it.
 */
async function completeReviewWithSources(args: {
  db: Db;
  playbookId: string;
  model: string;
  apiKeys: UserApiKeys;
  prompt: string;
  sources: PlaybookSourceRow[];
}): Promise<string> {
  const known = new Set(args.sources.map((source) => source.id));
  const result = await streamChatWithTools({
    model: args.model,
    systemPrompt: REVIEW_SYSTEM_PROMPT,
    messages: [{ role: "user", content: args.prompt }],
    tools: [READ_SOURCE_TOOL],
    maxIterations: 8,
    apiKeys: args.apiKeys,
    runTools: (calls) =>
      Promise.all(
        calls.map(async (call) => ({
          tool_use_id: call.id,
          content: await readSourceForReview(
            args.db,
            args.playbookId,
            known,
            call,
          ),
        })),
      ),
  });
  return result.fullText;
}

export async function readSourceForReview(
  db: Db,
  playbookId: string,
  known: ReadonlySet<string>,
  call: NormalizedToolCall,
): Promise<string> {
  if (call.name !== READ_SOURCE_TOOL.function.name)
    return `There is no tool named ${call.name}.`;
  const id = typeof call.input.documentId === "string" ? call.input.documentId : "";
  // Only this playbook's documents, whatever id the model produces.
  if (!known.has(id))
    return "No supplementary document has that id. Use an id from the SUPPLEMENTARY DOCUMENTS list.";
  const offset =
    typeof call.input.offset === "number" && Number.isFinite(call.input.offset)
      ? call.input.offset
      : 0;
  const page = await readPlaybookSourceText(db, playbookId, id, offset);
  if (!page) return "That supplementary document is no longer available.";
  if (!page.total) return `${page.filename} has no readable text.`;
  const more =
    page.next === null
      ? "This is the end of the document."
      : `Call again with offset ${page.next} to continue.`;
  return `${page.filename}, characters ${page.start}-${page.start + page.text.length} of ${page.total}. ${more}\n\n${page.text}`;
}

export async function listPlaybookRuns(
  userId: string,
  playbookId: string,
  db: Db = createServerSupabase(),
  email?: string | null,
) {
  await getPlaybook(userId, playbookId, db, email);
  const { data, error } = await db
    .from("playbook_runs")
    .select("*")
    .eq("playbook_id", playbookId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return withCurrentEditStatus(
    db,
    ((data ?? []) as Record<string, unknown>[]).map(publicRun),
  );
}

/**
 * A run stores each tracked change as it was made; accepting or rejecting it
 * later is recorded on the document, so read its current status back.
 */
async function withCurrentEditStatus<
  T extends { findings: { edit?: EditAnnotation | null }[] },
>(db: Db, runs: T[]): Promise<T[]> {
  const ids = runs.flatMap((run) =>
    run.findings.flatMap((finding) =>
      finding.edit?.edit_id ? [finding.edit.edit_id] : [],
    ),
  );
  if (!ids.length) return runs;
  const { data, error } = await db
    .from("document_edits")
    .select("id, status")
    .in("id", ids);
  if (error) throw error;
  const status = new Map(
    (data ?? []).map((row) => [String(row.id), row.status as string]),
  );
  return runs.map((run) => ({
    ...run,
    findings: run.findings.map((finding) => {
      const current = finding.edit && status.get(finding.edit.edit_id);
      return current === "accepted" ||
        current === "rejected" ||
        current === "pending"
        ? { ...finding, edit: { ...finding.edit!, status: current } }
        : finding;
    }),
  }));
}

function publicRun(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    playbookId: String(row.playbook_id),
    model: String(row.model),
    documentName: row.document_name ? String(row.document_name) : null,
    documentId: row.document_id ? String(row.document_id) : null,
    editedVersionId: row.edited_version_id
      ? String(row.edited_version_id)
      : null,
    reviewMode: (row.review_mode === "permissive" ? "permissive" : "strict") as
      | "permissive"
      | "strict",
    reviewScope: (row.review_scope === "issues" ? "issues" : "full") as
      | "full"
      | "issues",
    ...runState(row),
    summary: row.summary ? String(row.summary) : null,
    findings: (Array.isArray(row.findings_json)
      ? row.findings_json
      : (parseJson(row.findings_json) ?? [])) as PlaybookFinding[],
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  };
}

/**
 * The caller's runs across every playbook they can open in the workspace,
 * newest first, each named after its playbook. A run of a playbook they can no
 * longer open is left out.
 */
export async function listAllPlaybookRuns(
  userId: string,
  db: Db = createServerSupabase(),
  options: { workspace?: unknown; email?: string | null } = {},
) {
  const playbooks = await listPlaybooks(userId, db, options);
  if (!playbooks.length) return [];
  const names = new Map(
    playbooks.map((playbook) => [playbook.id, playbook.name]),
  );
  const { data, error } = await db
    .from("playbook_runs")
    .select("*")
    .eq("user_id", userId)
    .in("playbook_id", [...names.keys()])
    .order("started_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...publicRun(row),
    playbookName: names.get(String(row.playbook_id)) ?? "",
  }));
}

/**
 * A page of the caller's runs for the sidebar's History, newest first: only
 * what a row shows. `before` is the `startedAt` of the last run already read.
 */
export async function listPlaybookRunHistory(
  userId: string,
  db: Db = createServerSupabase(),
  options: {
    workspace?: unknown;
    email?: string | null;
    limit?: number;
    before?: string;
  } = {},
) {
  const playbooks = await listPlaybooks(userId, db, options);
  if (!playbooks.length) return [];
  const names = new Map(
    playbooks.map((playbook) => [playbook.id, playbook.name]),
  );
  let query = db
    .from("playbook_runs")
    .select(
      "id, playbook_id, document_name, status, error, started_at, updated_at, completed_at",
    )
    .eq("user_id", userId)
    .in("playbook_id", [...names.keys()]);
  if (options.before) query = query.lt("started_at", options.before);
  const { data, error } = await query
    .order("started_at", { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? 25, 1), 100));
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    playbookId: String(row.playbook_id),
    playbookName: names.get(String(row.playbook_id)) ?? "",
    documentName: row.document_name ? String(row.document_name) : null,
    ...runState(row),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
}

/**
 * Deletes one of the caller's runs. A review still running is refused: it
 * would write its findings to a run that no longer exists. Tracked changes it
 * made stay on the document, which keeps its own versions.
 */
export async function deletePlaybookRun(
  userId: string,
  runId: string,
  db: Db = createServerSupabase(),
) {
  const { data, error } = await db
    .from("playbook_runs")
    .select("id, status, error, started_at, updated_at")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Run not found.", 404);
  if (runState(data as Record<string, unknown>).status === "running")
    throw new PlaybookRequestError(
      "This review is still running. Delete it once it has finished.",
      409,
    );
  const deleted = await db
    .from("playbook_runs")
    .delete()
    .eq("id", runId)
    .eq("user_id", userId);
  if (deleted.error) throw deleted.error;
}

/** Small status snapshots of the caller's own runs, for polling. */
export async function playbookRunStatuses(
  userId: string,
  ids: string[],
  db: Db = createServerSupabase(),
) {
  if (!ids.length) return [];
  const { data, error } = await db
    .from("playbook_runs")
    .select("id, status, error, started_at, updated_at, completed_at")
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    id: String(row.id),
    status: runState(row).status,
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
}

/**
 * Where the Word or PDF file a playbook was imported from is stored, for anyone who
 * can view the playbook. Null when it was written in the app instead.
 */
export async function getPlaybookSource(
  userId: string,
  id: string,
  db: Db = createServerSupabase(),
  email?: string | null,
): Promise<{ storageKey: string; filename: string } | null> {
  // getPlaybook is the view-access check: creator, organization member of a
  // shared playbook, or a personal share recipient.
  await getPlaybook(userId, id, db, email);
  const { data, error } = await db
    .from("playbooks")
    .select("source_storage_key, source_filename")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data?.source_storage_key) return null;
  return {
    storageKey: String(data.source_storage_key),
    filename: data.source_filename
      ? String(data.source_filename)
      : "playbook.docx",
  };
}

export async function deletePlaybook(
  userId: string,
  id: string,
  db: Db = createServerSupabase(),
  email?: string | null,
): Promise<void> {
  await editablePlaybook(userId, id, db, email, "owner");
  const { data, error } = await db
    .from("playbooks")
    .select("source_storage_key")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Playbook not found.", 404);
  const sources = await listPlaybookSourceRows(db, id);
  // Runs and source rows cascade in this same statement. Deleting runs first
  // would lose review history if the playbook delete then failed.
  const playbook = await db.from("playbooks").delete().eq("id", id);
  if (playbook.error) throw playbook.error;
  if (data.source_storage_key)
    await deleteFile(String(data.source_storage_key)).catch(() => {});
  // Clear bytes promptly; the database also queues durable cleanup for failed
  // deletes and for cascades that do not pass through this request handler.
  for (const source of sources)
    await deleteFile(source.storageKey).catch(() => {});
}

export async function playbookConfiguration(
  userId: string,
  db: Db = createServerSupabase(),
  workspace?: unknown,
) {
  const orgId = await creationScope(db, userId, workspace);
  const { availableModelIds, defaultModel } = await availablePlaybookModels(
    userId,
    db,
    orgId,
  );
  return { availableModelIds, defaultModel };
}
