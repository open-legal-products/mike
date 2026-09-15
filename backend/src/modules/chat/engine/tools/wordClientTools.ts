/**
 * Client-executed tools for the Word add-in.
 *
 * The web assistant's tools run in the backend because the documents they
 * touch live in the backend. The active Word document only exists inside the
 * user's Word session, so its tools invert the execution site: the model
 * calls a normal tool, the backend forwards the call to the task pane over
 * the chat's SSE stream (`client_tool_call` frame), the pane executes it with
 * Office.js, and POSTs the result to /word-chat/tool-result. The pending-call
 * bridge below correlates that POST back to the awaiting tool loop, so the
 * model sees real per-edit success/failure instead of a write-only text
 * protocol it can never be corrected on.
 *
 * The bridge is in-memory and therefore single-instance: the POST must reach
 * the same process that is streaming the chat. That matches how the rest of
 * the streaming state (SSE socket, abort signal) already works.
 */
import { randomUUID } from "node:crypto";
import type { NormalizedToolCall, OpenAIToolSchema } from "../../../../lib/llm";
import { MAX_DOCUMENT_CONTEXT_CHARS, spotlight } from "../contextBuilders";
import { WORD_EDIT_FORMATS } from "../wordDocumentEdits";
import { ACTIVE_WORD_DOCUMENT_LIVE_FILENAME } from "../wordPrompt";
import { isAbortError } from "../streaming";
import type { AssistantEvent, ClientToolsAdapter } from "../streaming";

export const APPLY_WORD_EDITS_TOOL_NAME = "apply_word_edits";
export const READ_ACTIVE_DOCUMENT_TOOL_NAME = "read_active_document";

/**
 * Mirrors the add-in's per-edit outcome, minus Word-internal fields.
 *
 * "proposed" is the SUCCESSFUL outcome of Review mode — the pane's default.
 * There the pane only VALIDATES each edit against the live document and puts
 * a ready card in front of the user; the document is untouched until a human
 * clicks Apply. "applied" and "applied-unmanaged" are Edit mode's real
 * outcomes: the tracked change is in the document.
 */
export interface WordClientEditOutcome {
  index: number;
  status:
    | "applied"
    | "applied-unmanaged"
    | "proposed"
    | "not-found"
    | "ambiguous"
    | "skipped"
    /**
     * Backend-synthesized only (never sent by the pane): the pane did not
     * confirm in time, so the document may or may not carry the change. The
     * model must verify with read_active_document before retrying, or a
     * retry stacks a second tracked change over the first.
     */
    | "unknown"
    | "error";
  matches?: number;
  /** Word's skip reason, e.g. "pre-existing-revisions" or "unsearchable". */
  reason?: string;
  error?: string;
}

/**
 * One requested edit. The vocabulary deliberately mirrors the `<EDITS>` JSON
 * protocol row for row — `replacement` XOR `formats`, plus the explicit
 * replace-all opt-in — because both channels land in the same
 * `word_document_edits` row and are reviewed by the same card.
 */
export interface WordEditRequest {
  original: string;
  replacement: string;
  formats?: string[];
  occurrence?: "all";
  reason?: string;
}

export const MAX_EDITS_PER_CALL = 50;
/**
 * 200, not Word's 255-character search ceiling: the canonical edit row this
 * becomes (PUT /word-chat/messages/:id/edits/:blockIndex, and the
 * `<EDITS>` protocol it shares a table with) rejects an original_text longer
 * than 200. An edit the pane could apply but never persist would lose its
 * card on the next reload, so the tool boundary enforces the storage limit.
 */
const MAX_ORIGINAL_CHARS = 200;
const MAX_REPLACEMENT_CHARS = 10_000;
const MAX_REASON_CHARS = 500;
const MAX_CLIENT_ERROR_CHARS = 500;

/**
 * Per-turn guardrails, enforced per adapter instance (= one chat request).
 * A wedged pane must not burn 16 iterations x full deadline while holding the
 * SSE socket and paying for model calls, and repeated live reads must not
 * re-inject a 200k-char document into the context on every retry.
 */
const MAX_CONSECUTIVE_TIMEOUTS = 2;
const CLIENT_CALL_BUDGET = 12;
const MAX_LIVE_READS_PER_TURN = 3;

export const WORD_CLIENT_TOOLS: OpenAIToolSchema[] = [
  {
    type: "function",
    function: {
      name: APPLY_WORD_EDITS_TOOL_NAME,
      description:
        "Propose tracked-change edits to the active Word document open in " +
        "the user's Microsoft Word. Each edit replaces one exact contiguous " +
        "passage; an empty replacement deletes the passage. Send at most " +
        `${MAX_EDITS_PER_CALL} edits per call (a hard limit; larger batches ` +
        "are rejected outright) and split larger sets across " +
        "calls. The add-in returns counts plus a row for each edit that did " +
        "not succeed: not-found means the original text does not appear " +
        "verbatim, ambiguous means it appears more than once. Fix the " +
        "original text (re-read the document if needed) and retry only the " +
        "failed edits.",
      parameters: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            // minItems/maxItems are advisory only — provider schema
            // allowlists (Gemini's, for one) strip them — so the batch limit
            // also travels in the tool description above, which is the only
            // load-bearing signal, and is enforced in parseWordEditsInput.
            minItems: 1,
            maxItems: MAX_EDITS_PER_CALL,
            items: {
              type: "object",
              properties: {
                original: {
                  type: "string",
                  maxLength: MAX_ORIGINAL_CHARS,
                  description:
                    "Exact text copied character-for-character from one " +
                    "contiguous passage in a single paragraph of the active " +
                    "document. Preserve capitalization, punctuation, and " +
                    "spacing. Keep it at most 200 characters and unique in " +
                    "the document.",
                },
                replacement: {
                  type: "string",
                  maxLength: MAX_REPLACEMENT_CHARS,
                  description:
                    "Text to put in its place. Empty string deletes the " +
                    "passage. Send exactly one of replacement or formats.",
                },
                formats: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "Formatting to apply to the passage instead of replacing " +
                    "it: any of bold, italic, underline, heading1, heading2, " +
                    "heading3. Heading formats style the whole paragraph, so " +
                    "do not use one when the passage shares a paragraph with " +
                    "body text. Send exactly one of replacement or formats.",
                },
                occurrence: {
                  type: "string",
                  description:
                    'Only "all", and only for an explicit replace-all ' +
                    "request; the original must then be the exact repeated " +
                    "text. Omit it otherwise.",
                },
                reason: {
                  type: "string",
                  maxLength: MAX_REASON_CHARS,
                  description:
                    "One concise, user-facing sentence explaining the change.",
                },
              },
              required: ["original", "reason"],
            },
          },
        },
        required: ["edits"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: READ_ACTIVE_DOCUMENT_TOOL_NAME,
      description:
        "Read the active Word document's current text live from the user's " +
        "Word session, including tracked changes applied earlier in this " +
        "response. Use this after apply_word_edits when you need to verify " +
        "or continue working with the updated text — the active-word-document " +
        "snapshot from read_document does not reflect edits made during this " +
        "response. It also works as the first read of the document when no " +
        "snapshot is listed under AVAILABLE DOCUMENTS.",
      parameters: { type: "object", properties: {} },
    },
  },
];

const WORD_CLIENT_TOOL_NAMES = new Set(
  WORD_CLIENT_TOOLS.map((tool) => tool.function.name),
);

export function isWordClientToolName(name: string): boolean {
  return WORD_CLIENT_TOOL_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Pending-call bridge
// ---------------------------------------------------------------------------

/**
 * Base deadline for a client round trip. Reads and small batches finish in
 * seconds; a large batch pays several Office.js host round trips PER edit, so
 * apply deadlines scale with batch size (see applyTimeoutMsFor) instead of
 * using this flat value. 60s, not 120s: a live pane answers in seconds, and
 * every extra second holds the SSE socket and the model turn open.
 */
export const CLIENT_TOOL_RESULT_TIMEOUT_MS = 60_000;
const APPLY_TIMEOUT_BASE_MS = 30_000;
const APPLY_TIMEOUT_PER_EDIT_MS = 3_000;
const APPLY_TIMEOUT_MAX_MS = 180_000;
const KEEP_ALIVE_INTERVAL_MS = 15_000;

export function applyTimeoutMsFor(editCount: number): number {
  return Math.min(
    APPLY_TIMEOUT_MAX_MS,
    APPLY_TIMEOUT_BASE_MS + APPLY_TIMEOUT_PER_EDIT_MS * editCount,
  );
}

/**
 * Sentinel results the bridge itself produces. Downstream code identifies
 * them BY OBJECT IDENTITY, never by shape: a posted body can imitate the
 * fields but can never be reference-equal to a module-private constant, so a
 * client cannot forge the "unknown" (unconfirmed) status these map to.
 */
export const CLIENT_TOOL_TIMEOUT_RESULT = {
  error:
    "The Word add-in did not return a result in time. The edits may or may " +
    "not have been applied.",
} as const;

export const CLIENT_TOOL_CANCELLED_RESULT = {
  error:
    "The chat was cancelled before the add-in confirmed this edit. The " +
    "edits may or may not have been applied.",
} as const;

function isUnconfirmedSentinel(result: unknown): boolean {
  return (
    result === CLIENT_TOOL_TIMEOUT_RESULT ||
    result === CLIENT_TOOL_CANCELLED_RESULT
  );
}

interface PendingClientToolCall {
  userId: string;
  settle: (result: unknown) => void;
}

const pendingClientToolCalls = new Map<string, PendingClientToolCall>();

/** Test-only visibility into bridge occupancy. */
export function pendingClientToolCallCount(): number {
  return pendingClientToolCalls.size;
}

/**
 * Register a bridge id and wait for the add-in to POST its result.
 *
 * Resolves with the client's payload; on timeout it resolves with an error
 * object (the model should hear about the failure and decide what to do, not
 * crash the stream). Rejects only when the chat stream itself is aborted.
 */
export function waitForClientToolResult(params: {
  callId: string;
  userId: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<unknown> {
  const { callId, userId, signal } = params;
  const timeoutMs = params.timeoutMs ?? CLIENT_TOOL_RESULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = (): void => {
      pendingClientToolCalls.delete(callId);
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      const err = new Error("Stream aborted.");
      err.name = "AbortError";
      reject(err);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort);
    timer = setTimeout(() => {
      cleanup();
      resolve(CLIENT_TOOL_TIMEOUT_RESULT);
    }, timeoutMs);
    pendingClientToolCalls.set(callId, {
      userId,
      settle: (result) => {
        cleanup();
        resolve(result);
      },
    });
  });
}

/**
 * Deliver a client-posted result to the awaiting tool call. Returns false for
 * unknown/expired ids and for ids owned by a different user, so the route can
 * answer 404 without leaking whether the id ever existed.
 */
export function submitClientToolResult(
  callId: string,
  userId: string,
  result: unknown,
): boolean {
  const pending = pendingClientToolCalls.get(callId);
  if (!pending || pending.userId !== userId) return false;
  pending.settle(result);
  return true;
}

// ---------------------------------------------------------------------------
// Input/result normalization
// ---------------------------------------------------------------------------

/**
 * Validate one apply_word_edits input. Bad input fails fast HERE, with an
 * actionable message, instead of round-tripping to Word only to come back as
 * an unexplained skip.
 */
export function parseWordEditsInput(
  input: Record<string, unknown>,
): { ok: true; edits: WordEditRequest[] } | { ok: false; error: string } {
  const rawEdits = input.edits;
  if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
    return { ok: false, error: "edits must be a non-empty array" };
  }
  if (rawEdits.length > MAX_EDITS_PER_CALL) {
    return {
      ok: false,
      error: `Too many edits in one call (max ${MAX_EDITS_PER_CALL}). Split the work across calls.`,
    };
  }
  const edits: WordEditRequest[] = [];
  for (const [index, raw] of rawEdits.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: `edits[${index}] must be an object` };
    }
    const row = raw as Record<string, unknown>;
    if (typeof row.original !== "string" || row.original.length === 0) {
      return {
        ok: false,
        error: `edits[${index}].original must be a non-empty string`,
      };
    }
    // Word's search API cannot match across paragraph breaks and treats ^ as
    // a wildcard escape — such originals would round-trip to the pane only to
    // come back as an unexplained skip. Fail fast with the reason instead.
    if (/[\n\r]/.test(row.original)) {
      return {
        ok: false,
        error:
          `edits[${index}].original contains a line break. Each original ` +
          "must be one contiguous passage within a single paragraph; split " +
          "the change into one edit per paragraph.",
      };
    }
    if (row.original.includes("^")) {
      return {
        ok: false,
        error:
          `edits[${index}].original contains "^", which Word's search ` +
          "cannot match literally. Choose a nearby passage without it.",
      };
    }
    if (row.original.length > MAX_ORIGINAL_CHARS) {
      return {
        ok: false,
        error:
          `edits[${index}].original is ${row.original.length} characters; ` +
          `keep each original at most ${MAX_ORIGINAL_CHARS}. Use several ` +
          "smaller, targeted edits instead.",
      };
    }
    // Exactly one of the two change kinds, mirroring the <EDITS> row rule.
    // A row carrying both is ambiguous about what the card should show; a row
    // carrying neither is a no-op the pane would silently drop.
    const hasFormats = Array.isArray(row.formats) && row.formats.length > 0;
    const hasReplacement = typeof row.replacement === "string";
    if (hasFormats === hasReplacement) {
      return {
        ok: false,
        error:
          `edits[${index}] must carry exactly one of "replacement" (text to ` +
          'put in place, "" to delete) or "formats" (a non-empty list of ' +
          "formats to apply).",
      };
    }
    let formats: string[] | undefined;
    if (hasFormats) {
      const raw = row.formats as unknown[];
      if (
        raw.some(
          (format) =>
            typeof format !== "string" || !WORD_EDIT_FORMATS.has(format),
        )
      ) {
        return {
          ok: false,
          error:
            `edits[${index}].formats may only contain ` +
            `${[...WORD_EDIT_FORMATS].join(", ")}.`,
        };
      }
      formats = [...new Set(raw as string[])];
    } else if ((row.replacement as string).length > MAX_REPLACEMENT_CHARS) {
      return {
        ok: false,
        error: `edits[${index}].replacement exceeds ${MAX_REPLACEMENT_CHARS} characters`,
      };
    }
    if (
      row.occurrence !== undefined &&
      row.occurrence !== null &&
      row.occurrence !== "all"
    ) {
      return {
        ok: false,
        error: `edits[${index}].occurrence must be "all" or omitted`,
      };
    }
    const reason =
      typeof row.reason === "string" && row.reason.trim()
        ? row.reason.trim().slice(0, MAX_REASON_CHARS)
        : undefined;
    edits.push({
      original: row.original,
      replacement: hasReplacement ? (row.replacement as string) : "",
      ...(formats ? { formats } : {}),
      ...(row.occurrence === "all" ? { occurrence: "all" as const } : {}),
      ...(reason ? { reason } : {}),
    });
  }
  return { ok: true, edits };
}

// "unknown" is deliberately absent: only this module may synthesize it, via
// the identity-checked sentinels above. A client claiming it is
// indistinguishable from one that simply failed to report, and is treated as
// an error.
const EDIT_OUTCOME_STATUSES = new Set<WordClientEditOutcome["status"]>([
  "applied",
  "applied-unmanaged",
  "proposed",
  "not-found",
  "ambiguous",
  "skipped",
  "error",
]);

/**
 * Normalize whatever the client posted into one outcome row per requested
 * edit. Missing or malformed rows become errors — the model must never be
 * told an edit succeeded when the add-in didn't say so.
 */
export function normalizeEditOutcomes(
  requested: WordEditRequest[],
  clientResult: unknown,
): WordClientEditOutcome[] {
  // A bridge timeout/cancel is different from a client-reported failure: the
  // pane may have applied the edits and merely failed to confirm, so those
  // rows become "unknown", never "error". Retrying against an unverified
  // document is what stacks a second tracked change over the first.
  if (isUnconfirmedSentinel(clientResult)) {
    const error = (clientResult as { error: string }).error;
    return requested.map((_, index) => ({ index, status: "unknown", error }));
  }
  const record =
    clientResult &&
    typeof clientResult === "object" &&
    !Array.isArray(clientResult)
      ? (clientResult as Record<string, unknown>)
      : {};
  if (typeof record.error === "string" && record.error) {
    const error = record.error.slice(0, MAX_CLIENT_ERROR_CHARS);
    return requested.map((_, index) => ({ index, status: "error", error }));
  }
  // The posted array is untrusted: bound the scan so a pathological body
  // cannot balloon into millions of map entries, and ignore out-of-range
  // indices outright.
  const rows = (Array.isArray(record.edits) ? record.edits : []).slice(
    0,
    MAX_EDITS_PER_CALL,
  );
  const byIndex = new Map<number, Record<string, unknown>>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.index === "number" &&
      Number.isInteger(row.index) &&
      row.index >= 0 &&
      row.index < requested.length
    ) {
      byIndex.set(row.index, row);
    }
  }
  return requested.map((_, index) => {
    const row = byIndex.get(index);
    const status = row?.status;
    if (
      typeof status === "string" &&
      EDIT_OUTCOME_STATUSES.has(status as WordClientEditOutcome["status"])
    ) {
      return {
        index,
        status: status as WordClientEditOutcome["status"],
        ...(typeof row?.matches === "number" ? { matches: row.matches } : {}),
        ...(typeof row?.reason === "string" && row.reason
          ? { reason: row.reason.slice(0, 80) }
          : {}),
        ...(typeof row?.error === "string" && row.error
          ? { error: row.error.slice(0, MAX_CLIENT_ERROR_CHARS) }
          : {}),
      };
    }
    return {
      index,
      status: "error",
      error: "The Word add-in did not report a result for this edit.",
    };
  });
}

export function isAppliedOutcome(outcome: WordClientEditOutcome): boolean {
  return (
    outcome.status === "applied" || outcome.status === "applied-unmanaged"
  );
}

/**
 * The one-line instruction that turns each non-applied outcome into a next
 * action. Without it the model sees a bare status and guesses — usually by
 * retrying, which is exactly wrong for "proposed".
 */
export function editOutcomeHint(
  outcome: WordClientEditOutcome,
): string | undefined {
  if (outcome.status === "proposed") {
    return (
      "Validated and queued for the user's review — this is success, not a " +
      "failure. The change is NOT in the document yet and must not be " +
      "retried; tell the user it is ready for them to review."
    );
  }
  if (outcome.status === "not-found") {
    return "The original text was not found verbatim. Re-read the document and copy the passage exactly.";
  }
  if (outcome.status === "ambiguous") {
    return "The original text matches more than one place. Extend it with surrounding words until it is unique.";
  }
  if (outcome.status === "unknown") {
    return "The add-in did not confirm this edit. Call read_active_document and check whether the change is already present before retrying — retrying an applied edit would duplicate it.";
  }
  if (outcome.status === "applied-unmanaged") {
    return "Applied as a tracked change, but the add-in cannot offer Accept/Reject controls for it — the user reviews it in Word's Review tab.";
  }
  if (outcome.reason === "pre-existing-revisions") {
    return "This passage already contains a tracked change (possibly from an earlier edit in this response). Do not re-edit it; target text outside the existing change.";
  }
  if (outcome.reason === "unsearchable") {
    return "Word cannot search for this original (too long, or spans a paragraph break). Use a shorter passage within one paragraph.";
  }
  return undefined;
}

/**
 * Compact model-facing result: counts first, then one row per edit that is
 * not a clean apply, then one hint per outcome kind. Fully-applied rows carry
 * no information beyond the count, and repeating an identical hint per row
 * wastes tokens the retry loop then re-reads on every iteration.
 */
export function buildApplyResultPayload(
  outcomes: WordClientEditOutcome[],
): Record<string, unknown> {
  const applied = outcomes.filter(isAppliedOutcome).length;
  const proposed = outcomes.filter((o) => o.status === "proposed").length;
  const unknown = outcomes.filter((o) => o.status === "unknown").length;
  const reportRows = outcomes.filter((o) => o.status !== "applied");
  const hints: Record<string, string> = {};
  for (const outcome of reportRows) {
    const hint = editOutcomeHint(outcome);
    if (!hint) continue;
    hints[outcome.reason ?? outcome.status] = hint;
  }
  return {
    applied,
    // "proposed" is not a failure: the edit is waiting on a human, not on
    // the model. "unknown" is not a failure either: it needs verification,
    // not a retry. Counting either as failed provokes a pointless — and for
    // "unknown", document-corrupting — retry.
    ...(proposed ? { proposed } : {}),
    ...(unknown ? { unconfirmed: unknown } : {}),
    failed: outcomes.length - applied - proposed - unknown,
    ...(reportRows.length
      ? {
          edits: reportRows.map((outcome) => ({
            index: outcome.index,
            status: outcome.status,
            ...(outcome.matches !== undefined
              ? { matches: outcome.matches }
              : {}),
            // "skip_reason", not "reason": the request field named "reason"
            // is the model's own user-facing rationale, and echoing Word's
            // machine reason back under the same key reads as a mangled echo.
            ...(outcome.reason ? { skip_reason: outcome.reason } : {}),
            ...(outcome.error ? { error: outcome.error } : {}),
          })),
        }
      : {}),
    ...(Object.keys(hints).length ? { hints } : {}),
  };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * First block_index a tool-proposed edit may claim.
 *
 * Prose `<EDITS>` blocks number from 0 upward within a message. Tool edits
 * start high so the two channels can never collide on one
 * (message_id, block_index) row even if a model emits both in one turn — and
 * the pane derives its card keys and hidden bookmark ids from the same
 * offset, so both sides must count identically by construction (see
 * word-addin/src/taskpane/lib/wordTrackedEditKeys.ts).
 *
 * It stays well under the routes' 10_000 block_index ceiling, which is what
 * makes tool edits storable through the same PUT/PATCH endpoints.
 */
export const TOOL_EDIT_BLOCK_INDEX_BASE = 1_000;

/**
 * Build the runLLMStream adapter for one Word-chat request. `write` is the
 * request's SSE writer; every forwarded call gets a fresh bridge id so
 * concurrent chats (even for the same user) can never cross wires.
 */
export function createWordClientToolsAdapter(params: {
  userId: string;
  write: (s: string) => void;
  signal?: AbortSignal;
  nonce?: string;
  /** Test seam; production scales apply deadlines via applyTimeoutMsFor. */
  timeoutMs?: number;
}): ClientToolsAdapter {
  const { userId, write, signal, nonce, timeoutMs } = params;

  // Message-wide flat ordinal for this turn's tool edits. One adapter is one
  // chat request, and the pane counts the same way from the same base.
  let nextBlockIndex = TOOL_EDIT_BLOCK_INDEX_BASE;

  // Per-turn guard state (one adapter = one chat request).
  let consecutiveTimeouts = 0;
  let clientCallsUsed = 0;
  let liveReadsUsed = 0;
  let lastLiveReadText: string | null = null;

  const forwardCall = async (
    call: NormalizedToolCall,
    input: Record<string, unknown>,
    callTimeoutMs: number,
  ): Promise<unknown> => {
    const bridgeId = randomUUID();
    const pending = waitForClientToolResult({
      callId: bridgeId,
      userId,
      signal,
      timeoutMs: timeoutMs ?? callTimeoutMs,
    });
    let keepAlive: NodeJS.Timeout | null = null;
    try {
      write(
        `data: ${JSON.stringify({
          type: "client_tool_call",
          tool_call_id: bridgeId,
          name: call.name,
          input,
        })}\n\n`,
      );
      // No SSE data flows while the pane executes; comment frames keep
      // intermediaries from idling the stream out (the pane's readSSE ignores
      // any line not starting with "data:"). On a half-open TCP peer these
      // periodic writes are also what eventually surface the reset and fire
      // the request's close/abort path.
      keepAlive = setInterval(() => {
        write(": tool-wait\n\n");
      }, KEEP_ALIVE_INTERVAL_MS);
      const result = await pending;
      if (result === CLIENT_TOOL_TIMEOUT_RESULT) {
        consecutiveTimeouts += 1;
      } else {
        consecutiveTimeouts = 0;
      }
      return result;
    } catch (error) {
      // Any synchronous failure after registration (a throwing SSE writer —
      // not reachable with the current res.write, but this module must not
      // depend on that) would otherwise leave the pending entry to settle
      // later with no handler attached. Settle it and detach.
      submitClientToolResult(bridgeId, userId, CLIENT_TOOL_CANCELLED_RESULT);
      pending.catch(() => {});
      throw error;
    } finally {
      if (keepAlive) clearInterval(keepAlive);
    }
  };

  /**
   * One placement marker per requested edit, in request order, carrying the
   * canonical row's fields. Emitted for FAILED edits too: a card that says
   * "couldn't find this text" is the user's only record that the model tried.
   */
  const editBlockEvents = (
    edits: WordEditRequest[],
    firstBlockIndex: number,
  ): AssistantEvent[] =>
    edits.map((edit, offset) => ({
      type: "word_edit_block",
      block_index: firstBlockIndex + offset,
      original_text: edit.original,
      replacement_text: edit.replacement,
      formats: edit.formats ?? [],
      occurrence: edit.occurrence ?? null,
      reason: edit.reason ?? null,
    }));

  const executeApplyEdits = async (
    call: NormalizedToolCall,
  ): Promise<{ content: string; events: AssistantEvent[] }> => {
    const parsed = parseWordEditsInput(call.input);
    if (!parsed.ok) {
      // Nothing was forwarded, so the ordinal counter must not advance —
      // the pane never saw this call and will not have counted it either.
      return { content: JSON.stringify({ error: parsed.error }), events: [] };
    }
    const firstBlockIndex = nextBlockIndex;
    nextBlockIndex += parsed.edits.length;
    let clientResult: unknown;
    try {
      clientResult = await forwardCall(
        call,
        { block_index: firstBlockIndex, edits: parsed.edits },
        applyTimeoutMsFor(parsed.edits.length),
      );
    } catch (error) {
      if (!isAbortError(error)) throw error;
      // Stream aborted while the pane was (possibly) applying. Its tracked
      // changes may already be in the document, so the turn's event record
      // must still carry these edits. Returning normally lets the loop push
      // the placement markers into the partial turn before its own abort
      // check throws; history restore then probes each edit's bookmark to
      // find the survivors.
      return {
        content: JSON.stringify({ error: "The chat stream was cancelled." }),
        events: editBlockEvents(parsed.edits, firstBlockIndex),
      };
    }
    const outcomes = normalizeEditOutcomes(parsed.edits, clientResult);
    return {
      content: JSON.stringify(buildApplyResultPayload(outcomes)),
      events: editBlockEvents(parsed.edits, firstBlockIndex),
    };
  };

  const executeReadActiveDocument = async (
    call: NormalizedToolCall,
  ): Promise<{ content: string; events: AssistantEvent[] }> => {
    if (liveReadsUsed >= MAX_LIVE_READS_PER_TURN) {
      return {
        content: JSON.stringify({
          error:
            `Already read the live document ${MAX_LIVE_READS_PER_TURN} times ` +
            "in this response. Work from the text of the last read.",
        }),
        events: [],
      };
    }
    liveReadsUsed += 1;
    write(
      `data: ${JSON.stringify({
        type: "doc_read_start",
        filename: ACTIVE_WORD_DOCUMENT_LIVE_FILENAME,
      })}\n\n`,
    );
    const clientResult = await forwardCall(
      call,
      {},
      CLIENT_TOOL_RESULT_TIMEOUT_MS,
    );
    const record =
      clientResult &&
      typeof clientResult === "object" &&
      !Array.isArray(clientResult)
        ? (clientResult as Record<string, unknown>)
        : {};
    if (typeof record.document !== "string") {
      const error =
        typeof record.error === "string" && record.error
          ? record.error.slice(0, MAX_CLIENT_ERROR_CHARS)
          : "The Word add-in could not read the document.";
      return { content: JSON.stringify({ error }), events: [] };
    }
    write(
      `data: ${JSON.stringify({
        type: "doc_read",
        filename: ACTIVE_WORD_DOCUMENT_LIVE_FILENAME,
      })}\n\n`,
    );
    const readEvent: AssistantEvent = {
      type: "doc_read",
      filename: ACTIVE_WORD_DOCUMENT_LIVE_FILENAME,
    };
    // An identical re-read carries no information; every repeated 200k-char
    // body would otherwise ride along in the message list for the rest of the
    // turn's iterations.
    if (record.document === lastLiveReadText) {
      return {
        content: JSON.stringify({
          unchanged: true,
          note: "The live document text is identical to your previous read. Work from that text.",
        }),
        events: [readEvent],
      };
    }
    lastLiveReadText = record.document;
    // Same ceiling as the snapshot path (parseOptionalDocumentContext): the
    // return channel must not become a way to blow the context window with an
    // oversized — or maliciously posted — document body.
    const truncated = record.document.length > MAX_DOCUMENT_CONTEXT_CHARS;
    const documentText = truncated
      ? record.document.slice(0, MAX_DOCUMENT_CONTEXT_CHARS)
      : record.document;
    // The live body is untrusted document text, exactly like a stored
    // document's body returned by read_document — same spotlight fence.
    const body = nonce ? spotlight(documentText, nonce) : documentText;
    return {
      content: truncated
        ? `${body}\n\n[Document truncated at ${MAX_DOCUMENT_CONTEXT_CHARS} characters.]`
        : body,
      events: [readEvent],
    };
  };

  return {
    schemas: WORD_CLIENT_TOOLS,
    owns: isWordClientToolName,
    execute: async (call) => {
      // A pane that stopped answering will not start again mid-turn; keep
      // forwarding and the turn burns iterations x deadline while holding the
      // SSE socket and paying for model calls that go nowhere.
      if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
        return {
          content: JSON.stringify({
            error:
              "The Word add-in is not responding. Stop calling Word tools " +
              "and tell the user what happened and what remains unverified.",
          }),
          events: [],
        };
      }
      clientCallsUsed += 1;
      if (clientCallsUsed > CLIENT_CALL_BUDGET) {
        // Stop before the provider loop's iteration ceiling does: the loop
        // truncates silently (the model never sees the last tool result),
        // whereas this error still reaches the model in time to summarize.
        return {
          content: JSON.stringify({
            error:
              "The Word tool budget for this response is exhausted. Do not " +
              "call Word tools again; summarize the work completed so far.",
          }),
          events: [],
        };
      }
      if (call.name === APPLY_WORD_EDITS_TOOL_NAME) {
        return executeApplyEdits(call);
      }
      if (call.name === READ_ACTIVE_DOCUMENT_TOOL_NAME) {
        return executeReadActiveDocument(call);
      }
      return {
        content: JSON.stringify({
          error: `Tool '${call.name}' is not available.`,
        }),
        events: [],
      };
    },
  };
}
