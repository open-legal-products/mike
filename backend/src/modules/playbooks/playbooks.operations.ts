import crypto from "node:crypto";
const { jsonrepair } = require("jsonrepair") as {
    jsonrepair: (text: string) => string;
};
import { z } from "zod";
import { createServerSupabase } from "../../lib/supabase";
import { completeText, type UserApiKeys } from "../../lib/llm";
import { builtInModelIds, providerForModel } from "../../lib/llm/models";
import type { Provider } from "../../lib/llm/types";
import { hasApiKeyForModel } from "../../lib/modelSelection";
import { getUserApiKeys } from "../user/user.service";
import { deleteFile, uploadFile } from "../../lib/storage";
import {
  extractPlaybookWordStructure,
  type PlaybookWordStructure,
} from "./playbooks.word";

type Db = ReturnType<typeof createServerSupabase>;

const DEFAULT_PLAYBOOK_COMPILATION_TIMEOUT_MS = 300_000;
const PUBLISH_VERSION_ATTEMPTS = 5;
const POSTGRES_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code) === POSTGRES_UNIQUE_VIOLATION
  );
}

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
  rules: z.array(ruleSchema).min(1).max(200),
});

export const playbookContentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).default(""),
  globalGuidance: z.string().trim().max(20_000).default(""),
  representedParty: z.string().trim().max(300).default(""),
  documentTypes: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  jurisdictions: z.array(z.string().trim().min(1).max(200)).max(50).default([]),
  topics: z.array(topicSchema).min(1).max(200),
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
});

const reviewSchema = z.object({
  summary: z.string().trim().min(1).max(10_000),
  findings: z.array(findingSchema).max(1000),
});

export type PlaybookContent = z.infer<typeof playbookContentSchema>;
export type PlaybookFinding = z.infer<typeof findingSchema> & { id: string };

export type Playbook = {
  id: string;
  userId: string;
  name: string;
  description: string;
  status: "draft" | "published";
  draft: PlaybookContent;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  publishedName: string | null;
  sourceFilename: string | null;
  importModel: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PlaybookImportStage =
  | "validating_file"
  | "checking_model"
  | "extracting_word"
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
  readonly status: 400 | 404 | 409;

  constructor(
    message: string,
    status: 400 | 404 | 409 = 400,
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
  if (!Array.isArray(playbook.topics)) return value;
  return {
    ...playbook,
    topics: playbook.topics.map((topic) => {
      if (!topic || typeof topic !== "object" || Array.isArray(topic)) {
        return topic;
      }
      const topicRecord = topic as Record<string, unknown>;
      if (!Array.isArray(topicRecord.rules)) return topic;
      return {
        ...topicRecord,
        rules: topicRecord.rules.map((rule) => {
          if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
            return rule;
          }
          const ruleRecord = rule as Record<string, unknown>;
          if (!Array.isArray(ruleRecord.conditions)) return rule;
          return {
            ...ruleRecord,
            conditions: ruleRecord.conditions.map((condition) =>
              condition &&
              typeof condition === "object" &&
              !Array.isArray(condition)
                ? conditionObjectText(condition as Record<string, unknown>)
                : condition,
            ),
          };
        }),
      };
    }),
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

function zodIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The playbook is not valid.";
  const path = issue.path
    .map((part) => (typeof part === "number" ? `#${part + 1}` : String(part)))
    .join(" ");
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Parse caller-supplied playbook content. A schema violation here is a
 * correctable input problem — an empty playbook name, or a playbook left with
 * no topics — so it must surface as an explicit 4xx and never as a 500
 * carrying the raw Zod dump.
 */
function parsePlaybookContentInput(raw: unknown): PlaybookContent {
  const result = playbookContentSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new PlaybookRequestError(
    `The playbook could not be saved — ${zodIssueMessage(result.error)}`,
  );
}

function stableIds(content: PlaybookContent): PlaybookContent {
  return {
    ...content,
    topics: content.topics.map((topic, topicIndex) => ({
      ...topic,
      id: topic.id || `topic-${topicIndex + 1}`,
      rules: topic.rules.map((rule, ruleIndex) => ({
        ...rule,
        id: rule.id || `topic-${topicIndex + 1}-rule-${ruleIndex + 1}`,
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
  return {
    ...content,
    topics: content.topics.map((topic) => ({
      ...topic,
      rules: topic.rules.map((rule) => {
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
            `The model could not tie the imported rule “${rule.name}” to the source Word document.`,
          );
        }
        return { ...rule, standard, fallbacks, unacceptable, sourceRefs };
      }),
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
  | { available: true }
  | { available: false; reason: string };

const PROVIDER_DISPLAY_NAMES: Record<keyof UserApiKeys, string> = {
  claude: "Anthropic (Claude)",
  gemini: "Google (Gemini)",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  vercel: "Vercel AI Gateway",
  "opencode-go": "OpenCode Go",
  courtlistener: "CourtListener",
};

// Keyed rather than positional: a provider added later must not inherit the
// name of whichever branch happened to sit last.
function providerDisplayName(provider: keyof UserApiKeys): string {
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
  // hasApiKeyForModel is unconditionally true for Ollama, so an unavailable
  // model always sits behind a provider the user supplies a key for.
  return {
    available: false,
    reason: `${providerDisplayName(provider as keyof UserApiKeys)} API key is not configured.`,
  };
}

async function assertPlaybookModelAvailable(
  userId: string,
  model: string,
  db: Db,
): Promise<UserApiKeys> {
  const apiKeys = await getUserApiKeys(userId, db);
  const availability = playbookModelAvailability(model, apiKeys);
  if (!availability.available) throw new PlaybookRequestError(availability.reason);
  return apiKeys;
}

async function availablePlaybookModels(userId: string, db: Db) {
  const apiKeys = await getUserApiKeys(userId, db);
  const { data: profile } = await db
    .from("user_profiles")
    .select("title_model, tabular_model")
    .eq("user_id", userId)
    .maybeSingle();
  const candidateIds = [
    ...new Set([
      ...builtInModelIds(),
      ...(typeof profile?.title_model === "string"
        ? [profile.title_model]
        : []),
      ...(typeof profile?.tabular_model === "string"
        ? [profile.tabular_model]
        : []),
    ]),
  ];
  const availableModelIds = candidateIds.filter(
    (modelId) => playbookModelAvailability(modelId, apiKeys).available,
  );
  const preferred = [profile?.title_model, profile?.tabular_model].find(
    (modelId) =>
      typeof modelId === "string" && availableModelIds.includes(modelId),
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
  configured =
    process.env.PLAYBOOK_COMPILATION_TIMEOUT_MS?.trim() ||
    process.env.LLM_REQUEST_TIMEOUT_MS?.trim(),
): number {
  const value = Number(configured);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_PLAYBOOK_COMPILATION_TIMEOUT_MS;
}

// A stored draft that no longer satisfies the schema must not remove the
// playbook from the list: report it as an empty draft so the row stays
// visible and can still be deleted or re-imported.
const UNREADABLE_DRAFT: PlaybookContent = {
  name: "",
  description: "",
  representedParty: "",
  globalGuidance: "",
  documentTypes: [],
  jurisdictions: [],
  topics: [],
};

function publicPlaybook(
  row: Record<string, unknown>,
  published: { versionNumber: number; name: string } | null,
): Playbook {
  const parsed = playbookContentSchema.safeParse(parseJson(row.draft_json));
  if (!parsed.success) {
    console.error("[playbooks] stored draft failed validation", {
      playbookId: row.id,
      issue: parsed.error.issues[0]?.message,
    });
  }
  const draft = parsed.success
    ? stableIds(parsed.data)
    : { ...UNREADABLE_DRAFT, name: String(row.name ?? "") };
  return {
    id: String(row.id),
    userId: String(row.user_id),
    name: String(row.name),
    description: String(row.description ?? ""),
    status: row.status === "published" ? "published" : "draft",
    draft,
    publishedVersionId: row.published_version_id
      ? String(row.published_version_id)
      : null,
    publishedVersionNumber: published?.versionNumber ?? null,
    publishedName: published?.name ?? null,
    sourceFilename: row.source_filename ? String(row.source_filename) : null,
    importModel: row.import_model ? String(row.import_model) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

type PublishedVersionInfo = { versionNumber: number; name: string };

function publishedVersionInfoFromRow(
  row: Record<string, unknown>,
): PublishedVersionInfo {
  const parsed = playbookContentSchema.safeParse(parseJson(row.content_json));
  return {
    versionNumber: Number(row.version_number),
    name: parsed.success ? parsed.data.name : "",
  };
}

async function publishedVersionInfo(
  db: Db,
  versionId: unknown,
): Promise<PublishedVersionInfo | null> {
  if (!versionId) return null;
  const { data } = await db
    .from("playbook_versions")
    .select("version_number, content_json")
    .eq("id", String(versionId))
    .maybeSingle();
  if (!data) return null;
  return publishedVersionInfoFromRow(data);
}

// One query for every published version on the page, rather than one query
// per listed playbook.
async function publishedVersionInfoByVersionId(
  db: Db,
  versionIds: string[],
): Promise<Map<string, PublishedVersionInfo>> {
  const info = new Map<string, PublishedVersionInfo>();
  if (!versionIds.length) return info;
  const { data, error } = await db
    .from("playbook_versions")
    .select("id, version_number, content_json")
    .in("id", versionIds);
  if (error) throw error;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    info.set(String(row.id), publishedVersionInfoFromRow(row));
  }
  return info;
}

export async function listPlaybooks(
  userId: string,
  db: Db = createServerSupabase(),
): Promise<Playbook[]> {
  const { data, error } = await db
    .from("playbooks")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  const versionIds = [
    ...new Set(
      rows
        .map((row) => row.published_version_id)
        .filter((id): id is string => typeof id === "string" && !!id),
    ),
  ];
  const versions = await publishedVersionInfoByVersionId(db, versionIds);
  return rows.map((row) =>
    publicPlaybook(
      row,
      typeof row.published_version_id === "string"
        ? versions.get(row.published_version_id) ?? null
        : null,
    ),
  );
}

export async function getPlaybook(
  userId: string,
  id: string,
  db: Db = createServerSupabase(),
): Promise<Playbook> {
  const { data, error } = await db
    .from("playbooks")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Playbook not found.", 404);
  return publicPlaybook(
    data,
    await publishedVersionInfo(db, data.published_version_id),
  );
}

function compilationPrompt(
  structure: PlaybookWordStructure,
  requestedName: string,
): string {
  return `Convert the supplied human-authored legal playbook into structured rules. Preserve concepts and sample clauses; do not invent policy. A source marker such as [P4] or [T2R3C1] identifies the exact paragraph or table cell. Every rule and sample clause must cite the relevant sourceRefs.

Rules may contain a standard position, fallback positions, unacceptable positions, guidance, conditions, and escalation actions. A position can be a concept or exact language. Mark sample clause usage as illustrative, preferred, verbatim, accepted, or unacceptable. Use verbatim only when the source clearly requires exact wording. If a clause must be present, set required true. Keep uncertain material in guidance rather than guessing.

The conditions field must always be an array of plain JSON strings, for example ["Applies when annual fees exceed $100,000"]. Never put objects, arrays, numbers, or booleans inside conditions. Express each condition as one readable sentence. Only actions may contain objects, and every action object must contain string fields named scenario and instruction.

Return JSON only with this shape:
{"name":"${requestedName.replace(/["\\]/g, "")}","description":"","globalGuidance":"","representedParty":"","documentTypes":[],"jurisdictions":[],"topics":[{"id":"topic-1","name":"","rules":[{"id":"topic-1-rule-1","name":"","concept":"","scope":"clause|agreement","required":false,"guidance":"","standard":{"name":"Standard","criteria":"","sampleClauses":[{"text":"","usage":"illustrative|preferred|verbatim|accepted|unacceptable","sourceRefs":["P1"]}]}|null,"fallbacks":[],"unacceptable":[],"conditions":[],"actions":[{"scenario":"","instruction":""}],"sourceRefs":["P1"]}]}]}

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

async function playbookSourceStorageKey(
  db: Db,
  userId: string,
  playbookId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("playbooks")
    .select("source_storage_key")
    .eq("id", playbookId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data?.source_storage_key ? String(data.source_storage_key) : null;
}

export async function importPlaybookFromDocx(args: {
  userId: string;
  filename: string;
  buffer: Buffer;
  name?: string;
  model: string;
  /** Replace this playbook's draft instead of creating a new playbook. */
  playbookId?: string;
  db?: Db;
  dependencies?: {
    completeText?: typeof completeText;
  };
}): Promise<Playbook> {
  const db = args.db ?? createServerSupabase();
  const now = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const model = args.model.trim();
  const compilationTimeoutMs = playbookCompilationTimeoutMs();
  let stage: PlaybookImportStage = "validating_file";
  let uploadedStorageKey: string | null = null;
  const attempt = await db.from("playbook_imports").insert({
    id: attemptId,
    user_id: args.userId,
    filename: args.filename,
    requested_name: args.name?.trim() || null,
    model,
    status: "running",
    stage,
    error: null,
    playbook_id: args.playbookId ?? null,
    started_at: now,
    completed_at: null,
    created_at: now,
    updated_at: now,
  });
  if (attempt.error) throw attempt.error;

  try {
    if (!args.filename.toLowerCase().endsWith(".docx"))
      throw new PlaybookRequestError("Playbook import currently requires a .docx file.");
    if (!args.buffer.length) throw new PlaybookRequestError("The uploaded playbook is empty.");

    // Resolve the replace target first. An unknown or unowned playbook must
    // fail before the import spends a model call on it.
    const replacing = args.playbookId
      ? await getPlaybook(args.userId, args.playbookId, db)
      : null;

    stage = "checking_model";
    await updateImportAttempt(db, attemptId, { stage });
    validateModel(model);
    const apiKeys = await assertPlaybookModelAvailable(args.userId, model, db);

    stage = "extracting_word";
    await updateImportAttempt(db, attemptId, { stage });
    const structure = await extractPlaybookWordStructure(args.buffer);
    if (structure.text.length > 150_000) {
      throw new PlaybookRequestError(
        "The Word playbook is too large to compile in one pass. Split it into smaller playbooks before importing.",
      );
    }
    const fallbackName =
      args.filename.replace(/\.docx$/i, "").trim() || "Imported playbook";
    const name = args.name?.trim() || replacing?.name || fallbackName;

    stage = "compiling";
    await updateImportAttempt(db, attemptId, { stage });
    const runCompletion = args.dependencies?.completeText ?? completeText;
    const raw = await withCompilationTimeout(runCompletion({
      model,
      systemPrompt:
        "You compile legal playbooks into auditable structured data. Return only valid JSON and never add legal positions absent from the source.",
      user: compilationPrompt(structure, name),
      maxTokens: 16_000,
      apiKeys,
    }), compilationTimeoutMs);

    stage = "validating_output";
    await updateImportAttempt(db, attemptId, { stage });
    const content = await validatePlaybookCompilationWithRetry({
      raw,
      structure,
      retry: async (validationError) => {
        stage = "repairing_output";
        await updateImportAttempt(db, attemptId, { stage });
        const retried = await withCompilationTimeout(runCompletion({
          model,
          systemPrompt:
            "You compile legal playbooks into auditable structured data. Your previous response failed validation. Return exactly one complete valid JSON object and no other text.",
          user: compilationRetryPrompt(structure, name, validationError),
          maxTokens: 16_000,
          apiKeys,
        }), compilationTimeoutMs);
        stage = "validating_output";
        await updateImportAttempt(db, attemptId, { stage });
        return retried;
      },
    });
    const id = replacing?.id ?? crypto.randomUUID();
    // The key carries the attempt id so a replacement never overwrites the
    // current source before its row update commits.
    const storageKey = `playbooks/${args.userId}/${id}/source-${attemptId}.docx`;
    const previousStorageKey = replacing
      ? await playbookSourceStorageKey(db, args.userId, id)
      : null;

    stage = "storing_source";
    await updateImportAttempt(db, attemptId, { stage });
    await uploadFile(
      storageKey,
      args.buffer.buffer.slice(
        args.buffer.byteOffset,
        args.buffer.byteOffset + args.buffer.byteLength,
      ) as ArrayBuffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    uploadedStorageKey = storageKey;

    stage = "saving_playbook";
    await updateImportAttempt(db, attemptId, { stage });
    // A replacement rewrites the draft only. Published versions stay
    // immutable, so a review already run against a published version keeps
    // its meaning after the Word source changes.
    const { error } = replacing
      ? await db
          .from("playbooks")
          .update({
            name: content.name,
            description: content.description,
            status: "draft",
            draft_json: content,
            source_filename: args.filename,
            source_storage_key: storageKey,
            source_structure_json: structure,
            import_model: model,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id)
          .eq("user_id", args.userId)
      : await db.from("playbooks").insert({
          id,
          user_id: args.userId,
          name: content.name,
          description: content.description,
          status: "draft",
          draft_json: content,
          published_version_id: null,
          source_filename: args.filename,
          source_storage_key: storageKey,
          source_structure_json: structure,
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
          error: cleanupError,
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
        error:
          auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    return getPlaybook(args.userId, id, db);
  } catch (error) {
    console.error("[playbooks] import failed", { attemptId, stage, error });
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
        error:
          auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    throw new PlaybookImportError(
      `Playbook import failed during ${importStageLabel(stage)}: ${message}`,
      attemptId,
      stage,
      { cause: error },
    );
  }
}

/**
 * Every rule needs a concept: the review model has nothing to look for
 * without one, and the schema requires it. A new rule therefore starts with
 * placeholder text the author replaces, not an empty string.
 */
export const BLANK_RULE_CONCEPT =
  "Describe the contract term this rule looks for.";

export function blankPlaybookContent(name: string): PlaybookContent {
  return playbookContentSchema.parse({
    name,
    topics: [
      {
        id: "topic-1",
        name: "New topic",
        rules: [
          {
            id: "topic-1-rule-1",
            name: "New rule",
            concept: BLANK_RULE_CONCEPT,
          },
        ],
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
  rawName: string | undefined,
  db: Db = createServerSupabase(),
): Promise<Playbook> {
  const name = rawName?.trim() || "Untitled playbook";
  if (name.length > 200)
    throw new PlaybookRequestError("The playbook name is too long.");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const draft = blankPlaybookContent(name);
  const { error } = await db.from("playbooks").insert({
    id,
    user_id: userId,
    name: draft.name,
    description: draft.description,
    status: "draft",
    draft_json: draft,
    published_version_id: null,
    source_filename: null,
    source_storage_key: null,
    source_structure_json: null,
    import_model: null,
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;
  return getPlaybook(userId, id, db);
}

export async function updatePlaybookDraft(
  userId: string,
  id: string,
  raw: unknown,
  db: Db = createServerSupabase(),
): Promise<Playbook> {
  await getPlaybook(userId, id, db);
  const draft = stableIds(parsePlaybookContentInput(raw));
  const { error } = await db
    .from("playbooks")
    .update({
      name: draft.name,
      description: draft.description,
      draft_json: draft,
      status: "draft",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
  return getPlaybook(userId, id, db);
}

export async function publishPlaybook(
  userId: string,
  id: string,
  db: Db = createServerSupabase(),
): Promise<Playbook> {
  const playbook = await getPlaybook(userId, id, db);
  const versionId = crypto.randomUUID();
  const now = new Date().toISOString();
  // Reading the highest version number and inserting the next one is not
  // atomic, so two concurrent publishes can choose the same number. The
  // unique(playbook_id, version_number) constraint rejects the loser; re-read
  // and try again rather than failing the request.
  let inserted = false;
  for (let attempt = 0; attempt < PUBLISH_VERSION_ATTEMPTS; attempt += 1) {
    const { data: versions, error: versionError } = await db
      .from("playbook_versions")
      .select("version_number")
      .eq("playbook_id", id)
      .order("version_number", { ascending: false })
      .limit(1);
    if (versionError) throw versionError;
    const next = Number(versions?.[0]?.version_number ?? 0) + 1;
    const { error } = await db.from("playbook_versions").insert({
      id: versionId,
      playbook_id: id,
      user_id: userId,
      version_number: next,
      content_json: playbook.draft,
      created_at: now,
    });
    if (!error) {
      inserted = true;
      break;
    }
    if (!isUniqueViolation(error)) throw error;
  }
  if (!inserted)
    throw new PlaybookRequestError(
      "The playbook was published from somewhere else at the same time. Try again.",
      409,
    );
  const updated = await db
    .from("playbooks")
    .update({
      status: "published",
      published_version_id: versionId,
      updated_at: now,
    })
    .eq("id", id)
    .eq("user_id", userId);
  if (updated.error) {
    await db
      .from("playbook_versions")
      .delete()
      .eq("id", versionId)
      .eq("user_id", userId);
    throw updated.error;
  }
  return getPlaybook(userId, id, db);
}

async function publishedContent(
  userId: string,
  id: string,
  db: Db,
  requestedVersionId?: string,
): Promise<{
  playbook: Playbook;
  versionId: string;
  versionNumber: number;
  content: PlaybookContent;
}> {
  const playbook = await getPlaybook(userId, id, db);
  const versionId = requestedVersionId ?? playbook.publishedVersionId;
  if (!versionId)
    throw new PlaybookRequestError("Publish the playbook before running a review.");
  const { data, error } = await db
    .from("playbook_versions")
    .select("content_json, version_number")
    .eq("id", versionId)
    .eq("playbook_id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("The published playbook version was not found.", 404);
  return {
    playbook,
    versionId,
    versionNumber: Number(data.version_number),
    content: stableIds(
      playbookContentSchema.parse(parseJson(data.content_json)),
    ),
  };
}

function reviewPrompt(
  content: PlaybookContent,
  documentText: string,
  mode: "strict" | "permissive",
  instructions?: string,
): string {
  return `Review the full contract against the published playbook. Apply unacceptable positions first. In strict mode, fallback matches still need review. In permissive mode, a fallback may be acceptable but explain which fallback applies. Flag a missing required rule as missing_required. Use not_applicable only when an optional concept is absent. Quote exact contract text so Word can locate it. suggestedText must be a complete replacement for quote, or the complete clause to insert for missing_required. Do not suggest an edit for acceptable or not_applicable findings. Do not invent contract language or findings.

${instructions?.trim() ? `ADDITIONAL REVIEW INSTRUCTIONS:\n${instructions.trim().slice(0, 8_000)}\n` : ""}

Return JSON only:
{"summary":"","findings":[{"topicId":"topic-1|null","ruleId":"topic-1-rule-1|null","ruleName":"","status":"not_applicable|acceptable|needs_review|unacceptable|missing_required|outside_scope","quote":"exact contract text or empty when missing","location":"section or heading","analysis":"","suggestedText":""}]}

REVIEW MODE: ${mode}
PLAYBOOK:
${JSON.stringify(content).slice(0, 100_000)}

CONTRACT:
${documentText.slice(0, 180_000)}`;
}

type PlaybookPosition =
  PlaybookContent["topics"][number]["rules"][number]["fallbacks"][number];

function actualDocumentQuote(documentText: string, proposed: string): string {
  const quote = proposed.trim();
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
): PlaybookFinding[] {
  const rules = new Map<string, { topicId: string; name: string }>();
  // The prompt allows a null ruleId, and models commonly identify a rule by
  // name instead. Without this index that answer would be discarded and the
  // rule back-filled as "the model did not return a result" — the opposite of
  // what happened.
  const ruleIdByName = new Map<string, string>();
  for (const topic of content.topics) {
    for (const rule of topic.rules) {
      rules.set(rule.id!, { topicId: topic.id!, name: rule.name });
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
    });
  }
  for (const [ruleId, rule] of rules) {
    if (seen.has(ruleId)) continue;
    normalized.push({
      id: crypto.randomUUID(),
      topicId: rule.topicId,
      ruleId,
      ruleName: rule.name,
      status: "needs_review",
      quote: "",
      location: "",
      suggestedText: "",
      analysis:
        "The model did not return a result for this published rule. Review it manually before completing the playbook review.",
    });
  }
  return normalized;
}

export async function reviewWithPlaybook(args: {
  userId: string;
  playbookId: string;
  documentText: string;
  documentName?: string;
  instructions?: string;
  model: string;
  reviewMode: "strict" | "permissive";
  db?: Db;
}) {
  const db = args.db ?? createServerSupabase();
  validateModel(args.model);
  if (!args.documentText.trim()) throw new PlaybookRequestError("Document text is required.");
  if (args.documentText.length > 180_000)
    throw new PlaybookRequestError(
      "The document is too large for a complete playbook review. Review a shorter document or selected sections.",
    );
  const { versionId, versionNumber, content } = await publishedContent(
    args.userId,
    args.playbookId,
    db,
  );
  const apiKeys = await assertPlaybookModelAvailable(
    args.userId,
    args.model,
    db,
  );
  if (JSON.stringify(content).length > 100_000)
    throw new PlaybookRequestError(
      "The published playbook is too large for a complete review. Split it into smaller playbooks.",
    );
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const row = {
    id: runId,
    playbook_id: args.playbookId,
    version_id: versionId,
    user_id: args.userId,
    model: args.model,
    document_name: args.documentName?.trim() || null,
    review_mode: args.reviewMode,
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
  try {
    const raw = await completeText({
      model: args.model,
      systemPrompt:
        "You are a cautious contract review system. Apply only the supplied playbook and return auditable JSON.",
      user: reviewPrompt(content, args.documentText, args.reviewMode, args.instructions),
      maxTokens: 20_000,
      apiKeys,
    });
    const parsed = reviewSchema.parse(parseModelJson(raw));
    const findings = normalizeFindings(
      content,
      args.documentText,
      parsed.findings,
    );
    const completedAt = new Date().toISOString();
    const updated = await db
      .from("playbook_runs")
      .update({
        status: "completed",
        summary: parsed.summary,
        findings_json: findings,
        completed_at: completedAt,
        updated_at: completedAt,
      })
      .eq("id", runId)
      .eq("user_id", args.userId);
    if (updated.error) throw updated.error;
    return {
      id: runId,
      playbookId: args.playbookId,
      versionId,
      versionNumber,
      model: args.model,
      documentName: args.documentName ?? null,
      reviewMode: args.reviewMode,
      status: "completed" as const,
      summary: parsed.summary,
      findings,
      error: null,
      startedAt,
      completedAt,
    };
  } catch (error) {
    console.error("[playbooks] review failed", { runId, error });
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
  }
}

async function versionNumbersByVersionId(
  db: Db,
  versionIds: unknown[],
): Promise<Map<string, number>> {
  const numbers = new Map<string, number>();
  const ids = [
    ...new Set(
      versionIds.filter((id): id is string => typeof id === "string" && !!id),
    ),
  ];
  if (!ids.length) return numbers;
  const { data, error } = await db
    .from("playbook_versions")
    .select("id, version_number")
    .in("id", ids);
  if (error) throw error;
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    numbers.set(String(row.id), Number(row.version_number));
  }
  return numbers;
}

export async function listPlaybookRuns(
  userId: string,
  playbookId: string,
  db: Db = createServerSupabase(),
) {
  await getPlaybook(userId, playbookId, db);
  const { data, error } = await db
    .from("playbook_runs")
    .select("*")
    .eq("playbook_id", playbookId)
    .eq("user_id", userId)
    .order("started_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];
  const versionNumbers = await versionNumbersByVersionId(
    db,
    rows.map((row) => row.version_id),
  );
  return rows.map((row) => ({
    id: String(row.id),
    playbookId: String(row.playbook_id),
    versionId: String(row.version_id),
    versionNumber: versionNumbers.get(String(row.version_id)) ?? 0,
    model: String(row.model),
    documentName: row.document_name ? String(row.document_name) : null,
    reviewMode: row.review_mode === "permissive" ? "permissive" : "strict",
    status: String(row.status),
    summary: row.summary ? String(row.summary) : null,
    findings: Array.isArray(row.findings_json)
      ? row.findings_json
      : (parseJson(row.findings_json) ?? []),
    error: row.error ? String(row.error) : null,
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
  }));
}

export async function deletePlaybook(
  userId: string,
  id: string,
  db: Db = createServerSupabase(),
): Promise<void> {
  const { data, error } = await db
    .from("playbooks")
    .select("source_storage_key")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new PlaybookRequestError("Playbook not found.", 404);
  // supabase-js reports failures on the result rather than throwing. Check
  // each delete: reporting 204 after a refused delete leaves the playbook in
  // place while the UI drops it, and would orphan the stored source file.
  const runs = await db
    .from("playbook_runs")
    .delete()
    .eq("playbook_id", id)
    .eq("user_id", userId);
  if (runs.error) throw runs.error;
  const versions = await db
    .from("playbook_versions")
    .delete()
    .eq("playbook_id", id)
    .eq("user_id", userId);
  if (versions.error) throw versions.error;
  const playbook = await db
    .from("playbooks")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (playbook.error) throw playbook.error;
  if (data.source_storage_key)
    await deleteFile(String(data.source_storage_key)).catch(() => {});
}

export async function playbookConfiguration(
  userId: string,
  db: Db = createServerSupabase(),
) {
  const { availableModelIds, defaultModel } = await availablePlaybookModels(
    userId,
    db,
  );
  return { availableModelIds, defaultModel };
}
