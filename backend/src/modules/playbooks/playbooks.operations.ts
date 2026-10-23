import crypto from "node:crypto";
import { AppError } from "../../lib/appError";
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
import { uploadFile } from "../../lib/storage";
import { getFileStreamSource } from "../documents/documents.service";
import { liveDbJobDedupeKeys } from "../../lib/dbq/enqueue";
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
import {
  recordPlaybookImportAudit,
  recordPlaybookAudit,
  recordPlaybookRunAudit,
  recordPlaybookRunDeletedAudit,
} from "./playbooks.audit";
import { UserFacingError } from "../../lib/userFacingError";
import {
  importReportStage,
  removePlaybookObjects,
  reportPlaybookFailure,
  type PlaybookReportStage,
} from "./playbooks.reporting";
import { markStage } from "../../lib/observability/sentry";

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
export class PlaybookRequestError extends AppError {
  readonly status: 400 | 403 | 404 | 409;

  constructor(
    message: string,
    status: 400 | 403 | 404 | 409 = 400,
    options?: ErrorOptions,
  ) {
    super("playbooks.request_invalid", message, options);
    this.status = status;
  }
}

/**
 * The model's answer could not be used. The user sees the message, as with
 * any PlaybookRequestError, but unlike a refused request it is reported: a
 * model that stops producing valid output is something to know about.
 */
export class PlaybookModelOutputError extends PlaybookRequestError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 400, options);
    this.name = "PlaybookModelOutputError";
  }
}

/**
 * A failure that is the expected answer to the request (a bad file, a
 * missing or rejected key, no access), not a fault: shown to the user, never
 * reported to Sentry.
 */
export function isPlaybookRefusal(error: unknown): boolean {
  if (error instanceof PlaybookModelOutputError) return false;
  return (
    error instanceof PlaybookRequestError || error instanceof UserFacingError
  );
}

export class PlaybookImportError extends AppError {
  readonly code = "PLAYBOOK_IMPORT_FAILED";

  constructor(
    message: string,
    readonly attemptId: string,
    readonly stage: PlaybookImportStage,
    options?: ErrorOptions,
  ) {
    super("playbooks.import_failed", message, options);
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
    throw new PlaybookModelOutputError(
      "The model did not return structured JSON.",
    );
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
      throw new PlaybookModelOutputError(
        `The selected model returned invalid structured output twice. ${validationErrorMessage(retryError)}`,
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

/** Whether this write landed: false once another claim finished the attempt. */
async function updateImportAttempt(
  db: Db,
  attemptId: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await db
    .from("playbook_imports")
    .update({
      ...values,
      updated_at: new Date().toISOString(),
    })
    .eq("id", attemptId)
    // Only while it runs: a finished attempt's outcome is final.
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return Boolean((data as unknown[] | null)?.length);
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

/**
 * How often work in progress (a review or an import) records on its row that
 * it is still at it. The db_jobs lease cannot carry this: the runner fences
 * every write on the claim's `claimed_at`, so a handler may not renew it, and
 * its 10-minute stale threshold is longer than a reader should wait to learn
 * that work stopped.
 */
const PLAYBOOK_HEARTBEAT_MS = 30_000;
/** A running row whose heartbeat is older than this is no longer attended. */
const PLAYBOOK_SILENT_MS = 2 * 60_000;
/**
 * However fresh its heartbeat, work this old is presumed wedged, so a
 * re-claimed job stops deferring to it and runs the work itself.
 */
const PLAYBOOK_MAX_ATTENDED_MS = 60 * 60_000;

/** The db_jobs dedupe key of the job that runs a review. */
export function playbookReviewJobKey(runId: string): string {
  return `playbook.review:${runId}`;
}

/** The db_jobs dedupe key of the job that compiles an import. */
export function playbookImportJobKey(importId: string): string {
  return `playbook.import:${importId}`;
}

/**
 * True while some process is visibly working on a running row: its heartbeat
 * is recent and it has not been at it implausibly long.
 */
export function playbookWorkAttended(
  row: Record<string, unknown>,
  now = Date.now(),
): boolean {
  const lastSeen = Date.parse(String(row.updated_at ?? row.started_at));
  const started = Date.parse(String(row.started_at ?? row.updated_at));
  return (
    Number.isFinite(lastSeen) &&
    now - lastSeen <= PLAYBOOK_SILENT_MS &&
    !(Number.isFinite(started) && now - started > PLAYBOOK_MAX_ATTENDED_MS)
  );
}

/**
 * The running rows among `rows` that will never finish. A running row is
 * still running while a process heartbeats it, or while its job is pending or
 * claimed in db_jobs (a job waiting for a worker, or one whose worker died and
 * whose lease has not yet expired, will still run). Only a row that is both
 * silent and jobless is interrupted.
 */
async function interruptedPlaybookWork(
  db: Db,
  rows: Record<string, unknown>[],
  jobKey: (id: string) => string,
  now = Date.now(),
): Promise<Set<string>> {
  const silent = rows
    .filter(
      (row) => row.status === "running" && !playbookWorkAttended(row, now),
    )
    .map((row) => String(row.id));
  if (!silent.length) return new Set();
  const live = await liveDbJobDedupeKeys(db, silent.map(jobKey));
  return new Set(silent.filter((id) => !live.has(jobKey(id))));
}

/** Bump a running row's heartbeat until the returned stop is called. */
function keepPlaybookWorkAttended(
  db: Db,
  table: "playbook_runs" | "playbook_imports",
  id: string,
): () => void {
  // One report per piece of work: a database that is down fails every beat.
  let reported = false;
  const heartbeat = setInterval(() => {
    void db
      .from(table)
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "running")
      .then(({ error }) => {
        if (!error) return;
        if (!reported) {
          reported = true;
          const review = table === "playbook_runs";
          reportPlaybookFailure(error, {
            stage: "heartbeat",
            level: "warning",
            jobKind: review ? "playbook.review" : "playbook.import",
            ids: review ? { run_id: id } : { import_id: id },
          });
        }
        console.warn("[playbooks] heartbeat failed", {
          table,
          id,
          error: safeError(error),
        });
      });
  }, PLAYBOOK_HEARTBEAT_MS);
  heartbeat.unref?.();
  return () => clearInterval(heartbeat);
}

export const INTERRUPTED_IMPORT_ERROR =
  "The import stopped before it finished. Import the playbook again.";

/** A content write refused while a replacement import of the playbook runs. */
export const PLAYBOOK_BEING_REPLACED_ERROR =
  "This playbook is being replaced. Wait for the import to finish.";

/** A replacement whose target changed after the import began. */
export const PLAYBOOK_EDITED_DURING_REPLACEMENT_ERROR =
  "The playbook was edited while the replacement was compiling. Replace it again.";

/**
 * Refuse a write to a playbook's content while a replacement import of it
 * runs: the import rewrites the whole content when it finishes, so an edit
 * saved meanwhile would make it fail (compilePlaybookImport saves only over
 * the version it began from). Only an import that has resolved its target
 * holds the playbook, because only such an import compares against it; one
 * that will never finish (interruptedPlaybookWork) holds nothing.
 */
async function assertPlaybookNotBeingReplaced(
  db: Db,
  playbookId: string,
): Promise<void> {
  const { data, error } = await db
    .from("playbook_imports")
    .select("id, status, started_at, updated_at, target_updated_at")
    .eq("playbook_id", playbookId)
    .eq("status", "running");
  if (error) throw error;
  const replacing = ((data ?? []) as Record<string, unknown>[]).filter(
    (row) => row.target_updated_at,
  );
  if (!replacing.length) return;
  const interrupted = await interruptedPlaybookWork(
    db,
    replacing,
    playbookImportJobKey,
  );
  if (replacing.some((row) => !interrupted.has(String(row.id))))
    throw new PlaybookRequestError(PLAYBOOK_BEING_REPLACED_ERROR, 409);
}

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
 * An import's state as readers should see it; `interrupted` holds the ids
 * interruptedPlaybookWork found will never finish.
 */
function publicImport(
  row: Record<string, unknown>,
  interrupted: ReadonlySet<string>,
): PlaybookImport {
  const stopped = interrupted.has(String(row.id));
  const status = stopped ? "failed" : String(row.status);
  return {
    id: String(row.id),
    status:
      status === "completed" || status === "failed" ? status : "running",
    stage: String(row.stage),
    error: stopped
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
  const row = data as Record<string, unknown>;
  return publicImport(
    row,
    await interruptedPlaybookWork(db, [row], playbookImportJobKey),
  );
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
  const rows = (data ?? []) as Record<string, unknown>[];
  const interrupted = await interruptedPlaybookWork(
    db,
    rows,
    playbookImportJobKey,
  );
  return rows
    .map((row) => publicImport(row, interrupted))
    .filter((attempt) => attempt.status === "running");
}

/** What an import is asked to do, before its file is read. */
export type PlaybookImportRequest = {
  userId: string;
  /** Needed to replace a personal playbook shared with the caller. */
  userEmail?: string | null;
  filename: string;
  /** The file's size in bytes, known before it is read. */
  size: number;
  name?: string;
  workspace?: unknown;
  model: string;
  /** Replace this playbook's content instead of creating a new playbook. */
  playbookId?: string;
  db?: Db;
};

/**
 * Everything compiling an import needs besides the file's bytes: its row's
 * columns, plus two ids the row cannot hold. The replace target is kept
 * apart because the row's playbook_id is set null if that playbook is
 * deleted, and a new playbook's id is chosen up front so a re-run of the
 * same import saves the same playbook instead of a second one.
 */
export type PlaybookImportWork = {
  attemptId: string;
  userId: string;
  userEmail: string | null;
  filename: string;
  name: string | null;
  model: string;
  orgId: string | null;
  replacePlaybookId: string | null;
  /**
   * The replace target's updated_at when the import began. The compiled
   * content is saved only if the playbook still has it, so an edit made in
   * between fails the import instead of being overwritten. Absent only on a
   * job queued before the column existed.
   */
  targetUpdatedAt?: string | null;
  newPlaybookId: string;
  startedAt: string;
};

/** An import whose file is already in memory. */
type PlaybookImportArgs = Omit<PlaybookImportRequest, "size"> & {
  buffer: Buffer;
  dependencies?: {
    completeText?: typeof completeText;
  };
};

/**
 * Record that an import failed at `stage`, and return the error the caller
 * reports. Only messages this module wrote reach the row.
 */
async function recordImportFailure(
  db: Db,
  attemptId: string,
  stage: PlaybookImportStage,
  error: unknown,
  source: {
    filename: string;
    playbookId: string | null;
    /** The compile that failed, audited only by the claim whose write lands. */
    work?: PlaybookImportWork;
  },
): Promise<PlaybookImportError> {
  const report = {
    jobKind: "playbook.import" as const,
    fileType: playbookImportFileType(source.filename),
    ids: { import_id: attemptId, playbook_id: source.playbookId },
  };
  if (!isPlaybookRefusal(error))
    reportPlaybookFailure(error, { ...report, stage: importReportStage(stage) });
  // Not console.error: a refusal is not a fault, and a reported failure would
  // be filed again by the console bridge.
  console.warn("[playbooks] import failed", {
    attemptId,
    stage,
    error: safeError(error),
  });
  const message = playbookImportFailureMessage(stage, error);
  let recorded = false;
  try {
    recorded = await updateImportAttempt(db, attemptId, {
      status: "failed",
      stage,
      error: message,
      completed_at: new Date().toISOString(),
    });
  } catch (recordError) {
    reportPlaybookFailure(recordError, { ...report, stage: "import.record" });
    console.warn("[playbooks] failed to record import failure", {
      attemptId,
      error: safeError(recordError),
    });
  }
  if (recorded && source.work)
    await recordPlaybookImportAudit(db, source.work, { failedStage: stage });
  return new PlaybookImportError(
    `Playbook import failed during ${importStageLabel(stage)}: ${message}`,
    attemptId,
    stage,
    { cause: error },
  );
}

/**
 * The document a saved-document import reads, checked the way a download is:
 * the caller must be able to open it, and it must be small enough.
 */
export async function playbookImportDocument(
  db: Db,
  userId: string,
  userEmail: string | null | undefined,
  documentId: string,
): Promise<{ filename: string; size: number; storagePath: string }> {
  const source = await getFileStreamSource(
    documentId,
    userId,
    userEmail ?? undefined,
    null,
    db,
  );
  if (!source.ok) throw new PlaybookRequestError("Document not found.", 404);
  if (source.size > MAX_PLAYBOOK_IMPORT_BYTES)
    throw new PlaybookRequestError("The document is too large to import.");
  return {
    filename: source.filename,
    size: source.size,
    storagePath: source.storagePath,
  };
}

/**
 * Records an import and refuses, in the request that asked for it, anything
 * that can be refused without reading the file or calling the model: the
 * file type, an empty file, the replace target, the workspace, and the model.
 * Compiling is compilePlaybookImport's job, wherever it runs.
 */
/**
 * Enter an import stage: the stage the row records, and the breadcrumb a
 * failure later in the import arrives with, so a throw in `saving_playbook`
 * is told apart from the same throw reached from `storing_source`.
 */
function enterImportStage(stage: PlaybookImportStage): PlaybookImportStage {
  markStage(importReportStage(stage));
  return stage;
}

export async function beginPlaybookImport(
  args: PlaybookImportRequest,
): Promise<{ attempt: PlaybookImport; work: PlaybookImportWork }> {
  const db = args.db ?? createServerSupabase();
  const now = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const model = args.model.trim();
  let stage: PlaybookImportStage = enterImportStage("validating_file");
  const row = {
    id: attemptId,
    user_id: args.userId,
    filename: args.filename,
    requested_name: args.name?.trim() || null,
    model,
    status: "running",
    stage: stage as PlaybookImportStage,
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

  try {
    if (!playbookImportFileType(args.filename))
      throw new PlaybookRequestError(
        "Playbook import requires a .docx or .pdf file.",
      );
    if (!args.size)
      throw new PlaybookRequestError("The uploaded playbook is empty.");

    // Resolve the replace target first. An unknown or unowned playbook must
    // fail before the import spends a model call on it.
    const replacing = args.playbookId
      ? await editablePlaybook(args.userId, args.playbookId, db, args.userEmail)
      : null;
    row.org_id = replacing
      ? replacing.orgId
      : await creationScope(db, args.userId, args.workspace);
    // Read after the attempt was inserted as running: an edit that lands
    // after this read is refused (updatePlaybookContent) once the value below
    // is recorded, or detected when the import saves.
    const targetUpdatedAt = replacing?.updatedAt ?? null;

    stage = enterImportStage("checking_model");
    row.stage = stage;
    await updateImportAttempt(db, attemptId, {
      stage,
      org_id: row.org_id,
      target_updated_at: targetUpdatedAt,
    });
    validateModel(model);
    await assertPlaybookModelAvailable(args.userId, model, db, row.org_id);
    return {
      attempt: publicImport(row, new Set()),
      work: {
        attemptId,
        userId: args.userId,
        userEmail: args.userEmail ?? null,
        filename: args.filename,
        name: row.requested_name,
        model,
        orgId: row.org_id,
        replacePlaybookId: replacing?.id ?? null,
        targetUpdatedAt,
        newPlaybookId: crypto.randomUUID(),
        startedAt: now,
      },
    };
  } catch (error) {
    throw await recordImportFailure(db, attemptId, stage, error, {
      filename: args.filename,
      playbookId: args.playbookId ?? null,
    });
  }
}

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Compiles a recorded import from its file and saves the playbook. Safe to
 * run again for the same import, which is what a job re-claimed after its
 * worker died does: the source object's key and a new playbook's id both come
 * from the import, so a second run overwrites rather than duplicates, and
 * every write to the import row is guarded on it still running, so a run
 * that lost the race cannot overwrite the outcome the winner recorded.
 */
export async function compilePlaybookImport(
  db: Db,
  work: PlaybookImportWork,
  /** The file, or how to read it; a file that cannot be read fails the import. */
  file: Buffer | (() => Promise<Buffer>),
  dependencies: PlaybookImportArgs["dependencies"] = {},
): Promise<Playbook> {
  const { attemptId, userId, model } = work;
  const compilationTimeoutMs = playbookCompilationTimeoutMs();
  let stage: PlaybookImportStage = enterImportStage("validating_file");
  let uploadedStorageKey: string | null = null;
  const stopHeartbeat = keepPlaybookWorkAttended(
    db,
    "playbook_imports",
    attemptId,
  );
  try {
    const buffer = typeof file === "function" ? await file() : file;
    const fileType = playbookImportFileType(work.filename);
    if (!fileType)
      throw new PlaybookRequestError(
        "Playbook import requires a .docx or .pdf file.",
      );
    stage = enterImportStage("checking_model");
    // Checked again rather than trusted from the request: access to the
    // target, or the key for the model, can be lost while a job waits.
    const replacing = work.replacePlaybookId
      ? await editablePlaybook(userId, work.replacePlaybookId, db, work.userEmail)
      : null;
    const apiKeys = await assertPlaybookModelAvailable(
      userId,
      model,
      db,
      work.orgId,
    );

    stage = enterImportStage("extracting_text");
    await updateImportAttempt(db, attemptId, { stage });
    const structure =
      fileType === "pdf"
        ? await extractPlaybookPdfStructure(buffer)
        : await extractPlaybookWordStructure(buffer);
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
      work.filename.replace(/\.(docx|pdf)$/i, "").trim() || "Imported playbook";
    const name = work.name?.trim() || replacing?.name || fallbackName;

    stage = enterImportStage("compiling");
    await updateImportAttempt(db, attemptId, { stage });
    const runCompletion = dependencies.completeText ?? completeText;
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

    stage = enterImportStage("validating_output");
    await updateImportAttempt(db, attemptId, { stage });
    const content = await validatePlaybookCompilationWithRetry({
      raw,
      structure,
      retry: async (validationError) => {
        stage = enterImportStage("repairing_output");
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
        stage = enterImportStage("validating_output");
        await updateImportAttempt(db, attemptId, { stage });
        return retried;
      },
    });
    const id = replacing?.id ?? work.newPlaybookId;
    // The key carries the attempt id so a replacement never overwrites the
    // current source before its row update commits.
    // Under the creator's prefix, whoever replaces it.
    const storageKey = `playbooks/${replacing?.userId ?? userId}/${id}/source-${attemptId}.${fileType}`;
    const previousStorageKey = replacing
      ? await playbookSourceStorageKey(db, id)
      : null;

    stage = enterImportStage("storing_source");
    await updateImportAttempt(db, attemptId, { stage });
    await uploadFile(
      storageKey,
      buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer,
      PLAYBOOK_IMPORT_CONTENT_TYPES[fileType],
    );
    uploadedStorageKey = storageKey;

    stage = enterImportStage("saving_playbook");
    await updateImportAttempt(db, attemptId, { stage });
    // Review runs retain their own content snapshot when the source changes.
    const { data: replaced, error } = replacing
      ? await replacePlaybookContent(db, id, work.targetUpdatedAt, {
          name: content.name,
          description: content.description,
          content_json: content,
          source_filename: work.filename,
          source_storage_key: storageKey,
          import_model: model,
          updated_at: new Date().toISOString(),
        })
      : await db.from("playbooks").insert({
          id,
          user_id: userId,
          name: content.name,
          description: content.description,
          content_json: content,
          org_id: work.orgId,
          source_filename: work.filename,
          source_storage_key: storageKey,
          import_model: model,
          created_at: work.startedAt,
          updated_at: work.startedAt,
        });
    // A unique violation on the new playbook's id means an earlier run of
    // this same import already saved it, under the same source key: the
    // playbook exists, so this run only has to record that.
    if (error && (replacing || error.code !== UNIQUE_VIOLATION)) {
      await removePlaybookObjects([storageKey], {
        stage: "import.cleanup",
        ids: { import_id: attemptId, playbook_id: id },
      });
      uploadedStorageKey = null;
      throw error;
    }
    // Nothing matched: the playbook changed after the import began, unless
    // the change was an earlier run of this same import (its source key
    // names this attempt), which already saved this content. Otherwise the
    // catch below removes the uploaded source; the playbook is untouched.
    if (
      replacing &&
      !(replaced as unknown[] | null)?.length &&
      (await playbookSourceStorageKey(db, id)) !== storageKey
    )
      throw new PlaybookRequestError(
        PLAYBOOK_EDITED_DURING_REPLACEMENT_ERROR,
        409,
      );
    uploadedStorageKey = null;
    // The row now points at the new object, so the superseded one is safe to
    // remove. Losing this cleanup must not fail the import.
    if (previousStorageKey && previousStorageKey !== storageKey)
      await removePlaybookObjects([previousStorageKey], {
        stage: "import.cleanup",
        ids: { import_id: attemptId, playbook_id: id },
      });

    stage = enterImportStage("completed");
    // Not swallowed: an attempt left running after its playbook was saved
    // would read as interrupted, so a failed write here fails the run, and a
    // queued import runs again and lands on the unique-violation branch.
    const recorded = await updateImportAttempt(db, attemptId, {
      status: "completed",
      stage,
      playbook_id: id,
      completed_at: new Date().toISOString(),
    });
    const playbook = await getPlaybook(userId, id, db, work.userEmail);
    // Only the claim whose write landed records the import in the audit log.
    if (recorded) await recordPlaybookImportAudit(db, work, { playbook });
    return playbook;
  } catch (error) {
    if (uploadedStorageKey)
      await removePlaybookObjects([uploadedStorageKey], {
        stage: "import.cleanup",
        ids: { import_id: attemptId, playbook_id: work.replacePlaybookId },
      });
    throw await recordImportFailure(db, attemptId, stage, error, {
      filename: work.filename,
      playbookId: work.replacePlaybookId,
      work,
    });
  } finally {
    stopHeartbeat();
  }
}

/**
 * Write a replacement's content only if the playbook is still the version
 * the import began from. Every write to a playbook's content sets
 * updated_at in this module (there is no trigger), so an unchanged value
 * means no write since. A job queued before target_updated_at existed has
 * no value to compare and writes unguarded, as it always did.
 */
function replacePlaybookContent(
  db: Db,
  id: string,
  targetUpdatedAt: string | null | undefined,
  values: Record<string, unknown>,
) {
  const update = db.from("playbooks").update(values).eq("id", id);
  return (
    targetUpdatedAt ? update.eq("updated_at", targetUpdatedAt) : update
  ).select("id");
}

/**
 * Checks, records, and compiles an import in this process: the attempt is
 * returned once the file, target, and model are known to be usable, and
 * `done` settles when the playbook is saved. The import route queues the
 * compile as a durable job instead (playbooks.jobs.ts).
 */
export async function startPlaybookImport(
  args: PlaybookImportArgs,
): Promise<{ attempt: PlaybookImport; done: Promise<Playbook> }> {
  const db = args.db ?? createServerSupabase();
  const { attempt, work } = await beginPlaybookImport({
    ...args,
    db,
    size: args.buffer.length,
  });
  return {
    attempt,
    done: compilePlaybookImport(db, work, args.buffer, args.dependencies),
  };
}

/** Starts an import and waits for it: for callers that need the playbook. */
export async function importPlaybookFromFile(
  args: PlaybookImportArgs,
): Promise<Playbook> {
  const { done } = await startPlaybookImport(args);
  return done;
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
  email?: string | null,
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
  void recordPlaybookAudit(db, {
    userId,
    userEmail: email,
    orgId,
    action: "playbook.created",
    title: content.name,
    detail: { playbook_id: id },
  });
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
  await assertPlaybookNotBeingReplaced(db, id);
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

export const INTERRUPTED_RUN_ERROR =
  "The review stopped before it finished. Run it again.";

/**
 * A run's status as readers should see it; `interrupted` holds the ids
 * interruptedPlaybookWork found will never finish.
 */
function runState(
  row: Record<string, unknown>,
  interrupted: ReadonlySet<string>,
) {
  const stopped = interrupted.has(String(row.id));
  return {
    status: stopped ? "failed" : String(row.status),
    error: stopped
      ? INTERRUPTED_RUN_ERROR
      : row.error
        ? String(row.error)
        : null,
  };
}

/** The runs among `rows` that will never finish. */
function interruptedRuns(db: Db, rows: Record<string, unknown>[]) {
  return interruptedPlaybookWork(db, rows, playbookReviewJobKey);
}

/** Starts a review and waits for it: for callers that need the findings. */
export async function reviewWithPlaybook(args: PlaybookReviewRequest) {
  const { done } = await startPlaybookReview(args);
  return done;
}

export type PlaybookReviewRequest = {
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
};

/**
 * What a review needs that its run row does not record. The rules, model,
 * mode, scope, and document reference are all on the row; the text reviewed
 * and the document version the edits are made against are fixed here when the
 * review is requested, so a re-run reviews the same text and its edits are
 * refused, not doubled, if an earlier run already revised the document.
 */
export type PlaybookReviewInput = {
  runId: string;
  /** Also what account erasure purges queued jobs by (payload.userId). */
  userId: string;
  documentText: string;
  instructions: string | null;
  userEmail: string | null;
  expectedVersion: { id: string; storagePath: string } | null;
};

/** A review as runPlaybookReview performs it: its row plus its input. */
export type PlaybookReviewWork = PlaybookReviewInput & {
  playbookId: string;
  content: PlaybookContent;
  model: string;
  reviewMode: "strict" | "permissive";
  reviewScope: "full" | "issues";
  documentId: string | null;
  documentName: string | null;
  startedAt: string;
};

/** A stored run and its input, as the review that fills it reads them. */
export function playbookReviewWork(
  row: Record<string, unknown>,
  input: PlaybookReviewInput,
): PlaybookReviewWork {
  return {
    ...input,
    userId: String(row.user_id),
    playbookId: String(row.playbook_id),
    content: (parseJson(row.content_json) ?? row.content_json) as PlaybookContent,
    model: String(row.model),
    reviewMode: row.review_mode === "permissive" ? "permissive" : "strict",
    reviewScope: row.review_scope === "issues" ? "issues" : "full",
    documentId: row.document_id ? String(row.document_id) : null,
    documentName: row.document_name ? String(row.document_name) : null,
    startedAt: String(row.started_at),
  };
}

/**
 * Checks and records a review without running it: everything the request
 * can be refused for is refused here, and the stored row is the rules
 * snapshot the review is later run from.
 */
export async function beginPlaybookReview(args: PlaybookReviewRequest) {
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
  const input: PlaybookReviewInput = {
    runId,
    userId: args.userId,
    documentText,
    instructions: args.instructions ?? null,
    userEmail: args.userEmail ?? null,
    expectedVersion: stored?.version ?? null,
  };
  return {
    run: publicRun(row, new Set()),
    work: playbookReviewWork(row, input),
    apiKeys,
    db,
  };
}

/**
 * Checks and records a review, then runs it in this process: the run is
 * returned as soon as it is stored, and `done` settles when it finishes. The
 * review route queues the run as a durable job instead (playbooks.jobs.ts);
 * the chat tool, which waits for the findings, runs it here.
 */
export async function startPlaybookReview(args: PlaybookReviewRequest) {
  const { run, work, apiKeys, db } = await beginPlaybookReview(args);
  return { run, done: runPlaybookReview(db, work, apiKeys) };
}

/**
 * The organization whose keys a playbook's reviews use, for a review run
 * apart from the request that checked them.
 */
async function playbookKeyScope(db: Db, playbookId: string) {
  const { data, error } = await db
    .from("playbooks")
    .select("org_id")
    .eq("id", playbookId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Playbook not found.", 404);
  return (data.org_id as string | null) ?? null;
}

/**
 * Runs a recorded review and stores its outcome. Safe to run again for the
 * same run, which is what a job re-claimed after its worker died does: the
 * outcome is written with a guard on the run still being `running`, so of
 * two runs of one review only the first to finish records anything, and the
 * other's write matches no row. `apiKeys` is passed by a caller that just
 * checked them; a queued run looks them up again, since a key can be removed
 * while the job waits.
 */
export async function runPlaybookReview(
  db: Db,
  work: PlaybookReviewWork,
  apiKeys?: UserApiKeys,
) {
  const { runId } = work;
  const stopHeartbeat = keepPlaybookWorkAttended(db, "playbook_runs", runId);
  let stage: PlaybookReportStage = "review.model";
  markStage(stage);
  try {
    // Checked again rather than trusted from the request: access to the
    // playbook can be lost while a job waits, as compilePlaybookImport
    // checks its target.
    await getPlaybook(work.userId, work.playbookId, db, work.userEmail);
    const keys =
      apiKeys ??
      (await assertPlaybookModelAvailable(
        work.userId,
        work.model,
        db,
        await playbookKeyScope(db, work.playbookId),
      ));
    const sources = await listPlaybookSourceRows(db, work.playbookId);
    const scope = work.reviewScope;
    const prompt = reviewPrompt(
      work.content,
      work.documentText,
      work.reviewMode,
      work.instructions ?? undefined,
      sources,
      scope,
    );
    const raw = sources.length
      ? await completeReviewWithSources({
          db,
          playbookId: work.playbookId,
          model: work.model,
          apiKeys: keys,
          prompt,
          sources,
        })
      : await completeText({
          model: work.model,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          user: prompt,
          maxTokens: 20_000,
          apiKeys: keys,
        });
    const parsed = reviewSchema.parse(parseModelJson(raw));
    const normalized = normalizeFindings(
      work.content,
      work.documentText,
      parsed.findings,
      { flagMissingRules: scope === "full" },
    );
    // Held to the scope even if the model reports more.
    const reviewed =
      scope === "issues"
        ? normalized.filter((finding) => ISSUE_STATUSES.has(finding.status))
        : normalized;
    stage = "review.apply_edits";
    markStage(stage);
    const { findings, version } =
      work.documentId && work.expectedVersion
        ? await applyReviewEdits({
            db,
            userId: work.userId,
            userEmail: work.userEmail,
            documentId: work.documentId,
            expectedVersion: work.expectedVersion,
            findings: reviewed,
          })
        : { findings: reviewed, version: null };
    const versionId = version?.id ?? null;
    const completedAt = new Date().toISOString();
    stage = "review.save";
    markStage(stage);
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
      .eq("user_id", work.userId)
      .eq("status", "running")
      .select("id");
    if (updated.error) throw updated.error;
    // Only the claim whose write landed records the run in the audit log.
    if (updated.data?.length)
      await recordPlaybookRunAudit(db, work, { status: "completed", findings });
    return {
      id: runId,
      playbookId: work.playbookId,
      model: work.model,
      documentName: work.documentName,
      documentId: work.documentId,
      editedVersionId: versionId,
      /** For the response that made them; a stored run has only the id. */
      editedVersionNumber: version?.number ?? null,
      editedDownloadUrl: version?.downloadUrl ?? null,
      reviewMode: work.reviewMode,
      reviewScope: scope,
      status: "completed" as const,
      summary: parsed.summary,
      findings,
      error: null,
      startedAt: work.startedAt,
      completedAt,
    };
  } catch (error) {
    const report = {
      jobKind: "playbook.review" as const,
      ids: { run_id: runId, playbook_id: work.playbookId },
    };
    if (!isPlaybookRefusal(error)) reportPlaybookFailure(error, { ...report, stage });
    // Not console.error: see recordImportFailure.
    console.warn("[playbooks] review failed", { runId, error: safeError(error) });
    const completedAt = new Date().toISOString();
    const marked = await db
      .from("playbook_runs")
      .update({
        status: "failed",
        error: runFailureMessage(error),
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq("id", runId)
      .eq("user_id", work.userId)
      .eq("status", "running")
      .select("id");
    if (marked.error) {
      reportPlaybookFailure(marked.error, { ...report, stage: "review.record" });
      console.warn("[playbooks] failed to record review failure", {
        runId,
        error: safeError(marked.error),
      });
    }
    if (marked.data?.length)
      await recordPlaybookRunAudit(db, work, { status: "failed" });
    throw error;
  } finally {
    stopHeartbeat();
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
  const rows = (data ?? []) as Record<string, unknown>[];
  const interrupted = await interruptedRuns(db, rows);
  return withCurrentEditStatus(
    db,
    rows.map((row) => publicRun(row, interrupted)),
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

function publicRun(
  row: Record<string, unknown>,
  interrupted: ReadonlySet<string>,
) {
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
    ...runState(row, interrupted),
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
  const rows = (data ?? []) as Record<string, unknown>[];
  const interrupted = await interruptedRuns(db, rows);
  return rows.map((row) => ({
    ...publicRun(row, interrupted),
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
  const rows = (data ?? []) as Record<string, unknown>[];
  const interrupted = await interruptedRuns(db, rows);
  return rows.map((row) => ({
    id: String(row.id),
    playbookId: String(row.playbook_id),
    playbookName: names.get(String(row.playbook_id)) ?? "",
    documentName: row.document_name ? String(row.document_name) : null,
    ...runState(row, interrupted),
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
  email?: string | null,
) {
  const { data, error } = await db
    .from("playbook_runs")
    .select("id, playbook_id, document_id, status, error, started_at, updated_at")
    .eq("id", runId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Run not found.", 404);
  const row = data as Record<string, unknown>;
  // A run whose job is still queued or claimed will write to this row.
  if (runState(row, await interruptedRuns(db, [row])).status === "running")
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
  await recordPlaybookRunDeletedAudit(db, {
    userId,
    userEmail: email,
    runId,
    playbookId: String(row.playbook_id),
    documentId: row.document_id ? String(row.document_id) : null,
  });
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
  const rows = (data ?? []) as Record<string, unknown>[];
  const interrupted = await interruptedRuns(db, rows);
  return rows.map((row) => ({
    id: String(row.id),
    status: runState(row, interrupted).status,
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
  const playbook = await editablePlaybook(userId, id, db, email, "owner");
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
  const deleted = await db.from("playbooks").delete().eq("id", id);
  if (deleted.error) throw deleted.error;
  void recordPlaybookAudit(db, {
    userId,
    userEmail: email,
    orgId: playbook.orgId,
    action: "playbook.deleted",
    title: playbook.name,
    detail: { playbook_id: id },
  });
  // Clear bytes promptly; the database also queues durable cleanup for failed
  // deletes and for cascades that do not pass through this request handler.
  await removePlaybookObjects(
    [
      data.source_storage_key ? String(data.source_storage_key) : null,
      ...sources.map((source) => source.storageKey),
    ],
    { ids: { playbook_id: id } },
  );
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
