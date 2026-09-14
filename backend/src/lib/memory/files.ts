import { createHash } from "node:crypto";
import type { Db } from "../dbq/types";

export const MEMORY_MAX_BYTES = 16 * 1024;

export type MemoryScope = "user" | "project";
export type MemoryStatus = "idle" | "scheduled" | "processing" | "failed";
export type MemorySource = "manual" | "curator";
export type MemorySurface = "chat" | "word" | "tabular";

export type MemoryCurrent = {
  enabled: boolean;
  content: string;
  revision: number;
  hash: string | null;
  updated_at: string | null;
  updated_by: string | null;
  source: MemorySource | "wipe" | "settings" | null;
  status: MemoryStatus;
  status_updated_at: string;
};

export type MemoryFileRow = {
  id: string;
  scope: MemoryScope;
  user_id: string | null;
  project_id: string | null;
  enabled: boolean;
  epoch: number | string;
  revision: number | string;
  learning_cutoff_at: string;
  content: string;
  content_sha256: string | null;
  size_bytes: number;
  last_source_job_id: string | null;
  status: MemoryStatus;
  last_error_code: string | null;
  last_source: MemorySource | "wipe" | "settings" | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export class MemoryValidationError extends Error {}
export class MemoryRevisionConflictError extends Error {}
export class MemoryDisabledError extends Error {}
export class MemoryJobSupersededError extends Error {}
export class MemoryEpochSupersededError extends Error {}
export class MemoryConversationNotQuietError extends Error {}

function numberValue(value: number | string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeMemoryMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    throw new MemoryValidationError("content must be a string");
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^[ \t]*$/.test(line)) return "";
      const trailing = line.match(/[ \t]+$/)?.[0];
      if (!trailing) return line;
      const hardBreak = trailing.replace(/\t/g, "").length >= 2;
      return `${line.slice(0, -trailing.length)}${hardBreak ? "  " : ""}`;
    })
    .join("\n");
  if (/\0|[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(normalized)) {
    throw new MemoryValidationError("content contains unsupported characters");
  }
  if (
    /<\s*\/?\s*(?:script|iframe|object|embed|form|input|button|svg|math|style|link|meta|base)\b/i.test(
      normalized,
    ) ||
    /<[^>]+\bon[a-z]+\s*=/i.test(normalized) ||
    /<[^>]+\b(?:href|src|xlink:href)\s*=\s*["']?\s*(?:javascript\s*:|data\s*:\s*text\/html)/i.test(
      normalized,
    )
  ) {
    throw new MemoryValidationError("content contains executable HTML");
  }
  if (Buffer.byteLength(normalized, "utf8") > MEMORY_MAX_BYTES) {
    throw new MemoryValidationError(
      `content must be ${MEMORY_MAX_BYTES} bytes or fewer`,
    );
  }
  return normalized;
}

function memoryHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function ensureMemoryFile(
  db: Db,
  scope: MemoryScope,
  ownerId: string,
): Promise<MemoryFileRow> {
  const ownerColumn = scope === "user" ? "user_id" : "project_id";
  const { data: existing, error: readError } = await db
    .from("memory_files")
    .select("*")
    .eq("scope", scope)
    .eq(ownerColumn, ownerId)
    .maybeSingle();
  if (readError) throw new Error("Failed to load memory settings");
  if (existing) return existing as MemoryFileRow;

  const { data, error } = await db
    .from("memory_files")
    .upsert(
      {
        scope,
        [ownerColumn]: ownerId,
        enabled: true,
      },
      { onConflict: ownerColumn, ignoreDuplicates: true },
    )
    .select("*")
    .maybeSingle();
  if (error) throw new Error("Failed to create memory settings");
  if (data) return data as MemoryFileRow;

  const { data: raced, error: racedError } = await db
    .from("memory_files")
    .select("*")
    .eq("scope", scope)
    .eq(ownerColumn, ownerId)
    .single();
  if (racedError || !raced) throw new Error("Failed to create memory settings");
  return raced as MemoryFileRow;
}

export async function getMemoryCurrent(
  db: Db,
  scope: MemoryScope,
  ownerId: string,
): Promise<{ current: MemoryCurrent; file: MemoryFileRow }> {
  const file = await ensureMemoryFile(db, scope, ownerId);
  return { file, current: memoryCurrentFromFile(file) };
}

function memoryCurrentFromFile(file: MemoryFileRow): MemoryCurrent {
  const hasContent = !!file.content_sha256;
  return {
    enabled: file.enabled,
    content: file.content ?? "",
    // A monotonic change token, not a stored version: a destructive wipe
    // empties the body but advances it, so a draft loaded before the wipe
    // cannot recreate erased content after disable/re-enable.
    revision: numberValue(file.revision),
    hash: file.content_sha256,
    updated_at: hasContent ? (file.updated_at ?? null) : null,
    updated_by: hasContent ? (file.updated_by ?? null) : null,
    source: hasContent ? (file.last_source ?? null) : null,
    status: file.status,
    status_updated_at: file.updated_at,
  };
}

export async function writeMemoryFile(args: {
  db: Db;
  file: MemoryFileRow;
  content: string;
  expectedRevision: number;
  source: MemorySource;
  updatedBy: string | null;
  sourceSurface?: MemorySurface | null;
  sourceChatId?: string | null;
  sourceJobId?: string | null;
  consolidationStateId?: string | null;
  consolidationGeneration?: number | null;
  conversationGeneration?: number | null;
  sourceEpoch?: number | null;
  expectedEpoch?: number | null;
}): Promise<{ current: MemoryCurrent; applied: boolean }> {
  const content = normalizeMemoryMarkdown(args.content);
  const expectedRevision = numberValue(args.expectedRevision);
  // The row lock inside write_memory_file is the only place the enabled,
  // epoch, revision and unchanged-body decisions are made. A pre-check here
  // would be a second copy of those rules evaluated outside the lock: it
  // could only ever disagree with the authoritative answer, and skipping the
  // RPC for an unchanged body also skipped the job receipt that makes a
  // retried curator job idempotent.
  const expectedEpoch =
    args.expectedEpoch == null
      ? numberValue(args.file.epoch)
      : numberValue(args.expectedEpoch);
  const hash = memoryHash(content);

  const { data, error } = await args.db.rpc("write_memory_file", {
    p_memory_file_id: args.file.id,
    p_expected_revision: expectedRevision,
    p_expected_epoch: expectedEpoch,
    p_content: content,
    p_content_sha256: hash,
    p_size_bytes: Buffer.byteLength(content, "utf8"),
    p_source: args.source,
    p_updated_by: args.updatedBy,
    p_source_surface: args.sourceSurface ?? null,
    p_source_chat_id: args.sourceChatId ?? null,
    p_source_job_id: args.sourceJobId ?? null,
    p_consolidation_state_id: args.consolidationStateId ?? null,
    p_consolidation_generation: args.consolidationGeneration ?? null,
    p_conversation_generation: args.conversationGeneration ?? null,
    p_source_epoch: args.sourceEpoch ?? null,
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("memory_conversation_not_quiet")) {
      throw new MemoryConversationNotQuietError(
        "Memory conversation is not quiet",
      );
    }
    if (
      message.includes("memory_epoch_conflict") ||
      message.includes("memory_scope_ineligible")
    ) {
      if (args.expectedEpoch != null) {
        throw new MemoryEpochSupersededError("Memory scope was reset");
      }
      throw new MemoryRevisionConflictError("Memory revision changed");
    }
    if (message.includes("memory_revision_conflict")) {
      throw new MemoryRevisionConflictError("Memory revision changed");
    }
    if (message.includes("memory_disabled")) {
      throw new MemoryDisabledError("Memory is disabled");
    }
    if (message.includes("memory_job_superseded")) {
      throw new MemoryJobSupersededError("Memory curator job was superseded");
    }
    throw new Error("Failed to save memory");
  }

  const result = Array.isArray(data) ? data[0] : data;
  const applied = result?.applied !== false;
  return {
    applied,
    current: (
      await getMemoryCurrent(
        args.db,
        args.file.scope,
        (args.file.user_id ?? args.file.project_id) as string,
      )
    ).current,
  };
}

export async function wipeMemoryFile(args: {
  db: Db;
  file: MemoryFileRow;
  /** null preserves the enabled value resolved under the RPC's row lock. */
  enabled: boolean | null;
  updatedBy: string | null;
  source?: "wipe" | "settings";
}): Promise<MemoryCurrent> {
  const { data, error } = await args.db.rpc("wipe_memory_file", {
    p_memory_file_id: args.file.id,
    p_enabled: args.enabled,
    p_updated_by: args.updatedBy,
    p_source: args.source ?? "wipe",
  });
  if (error) throw new Error("Failed to wipe memory");
  const result = Array.isArray(data) ? data[0] : data;
  return {
    enabled:
      typeof result?.effective_enabled === "boolean"
        ? result.effective_enabled
        : (args.enabled ?? args.file.enabled),
    content: "",
    revision:
      result?.new_revision == null
        ? numberValue(args.file.revision) + 1
        : numberValue(result.new_revision),
    hash: null,
    updated_at: null,
    updated_by: null,
    source: args.source ?? "wipe",
    status: "idle",
    status_updated_at:
      typeof result?.mutation_at === "string"
        ? result.mutation_at
        : new Date().toISOString(),
  };
}

export async function enableMemoryFile(
  db: Db,
  file: MemoryFileRow,
  updatedBy: string,
): Promise<MemoryCurrent> {
  if (file.enabled) {
    return (
      await getMemoryCurrent(
        db,
        file.scope,
        (file.user_id ?? file.project_id) as string,
      )
    ).current;
  }
  const { data, error } = await db.rpc("enable_memory_file", {
    p_memory_file_id: file.id,
    p_updated_by: updatedBy,
  });
  if (error) throw new Error("Failed to enable memory");
  const result = Array.isArray(data) ? data[0] : data;
  return {
    enabled: true,
    content: "",
    revision: numberValue(result?.new_revision ?? file.revision),
    hash: null,
    updated_at: null,
    updated_by: null,
    source: "settings",
    status: "idle",
    status_updated_at:
      typeof result?.mutation_at === "string"
        ? result.mutation_at
        : new Date().toISOString(),
  };
}
