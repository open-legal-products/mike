import type {
  DocumentReadActivity,
  Message as SavedMessage,
  WordAssistantEvent,
  WordContentEvent,
  WordTextCardEvent,
  WordDocumentReadEvent,
  WordErrorEvent,
  WordEditBlockEvent,
  WordEditReferenceEvent,
  WordDocumentEdit,
  WordReasoningEvent,
  WordThinkingEvent,
} from "../types";
import type { WordAssistantMessage, WordChatMessage } from "./wordChatTypes";
import { projectRedlineStream } from "./redline";
import { isToolEditBlockIndex } from "./wordTrackedEditKeys";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Stable render identity for live-streamed events. React keys derived from
// array indices remount the activity strips when completeAssistantEvents
// filters an earlier event out — and in WKWebView, unmounting the DOM node
// its scroll anchoring latched onto can reset the transcript's scrollTop.
// Stamping identity at creation keeps every surviving event's subtree alive
// across completion. The key is inert if it reaches storage.
let liveEventKeyCounter = 0;

function nextEventKey(): string {
  liveEventKeyCounter += 1;
  return `live-${liveEventKeyCounter}`;
}

export function isWordThinkingEvent(
  event: WordAssistantEvent,
): event is WordThinkingEvent {
  return (
    event.type === "thinking" &&
    (event.isStreaming === undefined || typeof event.isStreaming === "boolean")
  );
}

export function isWordReasoningEvent(
  event: WordAssistantEvent,
): event is WordReasoningEvent {
  return (
    event.type === "reasoning" &&
    typeof event.text === "string" &&
    (event.isStreaming === undefined || typeof event.isStreaming === "boolean")
  );
}

export function isWordContentEvent(
  event: WordAssistantEvent,
): event is WordContentEvent {
  return (
    event.type === "content" &&
    typeof event.text === "string" &&
    (event.isStreaming === undefined || typeof event.isStreaming === "boolean")
  );
}

export function isWordTextCardEvent(
  event: WordAssistantEvent,
): event is WordTextCardEvent {
  return (
    event.type === "text_card" &&
    typeof event.card_id === "string" &&
    typeof event.title === "string" &&
    typeof event.text === "string"
  );
}

export function isWordDocumentReadEvent(
  event: WordAssistantEvent,
): event is WordDocumentReadEvent {
  return (
    event.type === "doc_read" &&
    typeof event.filename === "string" &&
    (event.status === "reading" || event.status === "read")
  );
}

function isWordErrorEvent(event: WordAssistantEvent): event is WordErrorEvent {
  return event.type === "error" && typeof event.message === "string";
}

export function isWordEditReferenceEvent(
  event: WordAssistantEvent,
): event is WordEditReferenceEvent {
  return event.type === "word_edit_ref" && typeof event.editId === "string";
}

export function isWordEditBlockEvent(
  event: WordAssistantEvent,
): event is WordEditBlockEvent {
  return (
    event.type === "word_edit_block" && typeof event.blockIndex === "number"
  );
}

/**
 * Adapt a web-style persisted assistant event array for the Word runtime.
 *
 * Every object with a string `type` is retained, including activity the Word
 * surface does not render. Known events gain the small camelCase/status
 * projection Word needs, while their original backend fields remain intact.
 */
export function normalizeStoredAssistantEvents(
  value: unknown,
): WordAssistantEvent[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item): WordAssistantEvent[] => {
    if (!isRecord(item) || typeof item.type !== "string") return [];
    const event = { ...item, type: item.type };

    if (item.type === "content" && typeof item.text === "string") {
      return [{ ...event, type: "content", text: item.text }];
    }
    if (item.type === "reasoning" && typeof item.text === "string") {
      return [
        {
          ...event,
          type: "reasoning",
          text: item.text,
          ...(typeof item.isStreaming === "boolean"
            ? { isStreaming: item.isStreaming }
            : {}),
        },
      ];
    }
    if (
      item.type === "doc_read" &&
      typeof item.filename === "string" &&
      item.filename
    ) {
      const documentId =
        typeof item.documentId === "string" && item.documentId
          ? item.documentId
          : typeof item.document_id === "string" && item.document_id
            ? item.document_id
            : undefined;
      const status =
        item.status === "reading" || item.status === "read"
          ? item.status
          : item.isStreaming === true
            ? "reading"
            : "read";
      return [
        {
          ...event,
          type: "doc_read",
          filename: item.filename,
          ...(documentId ? { documentId } : {}),
          status,
        },
      ];
    }
    if (item.type === "error" && typeof item.message === "string") {
      return [{ ...event, type: "error", message: item.message }];
    }
    if (item.type === "word_edit_block") {
      // Only reachable when a turn's finalizer could not run (a save that
      // failed mid-stream). Keep the placement rather than dropping the card.
      const blockIndex =
        typeof item.blockIndex === "number"
          ? item.blockIndex
          : typeof item.block_index === "number"
            ? item.block_index
            : null;
      if (blockIndex === null) return [event];
      return [{ ...event, type: "word_edit_block", blockIndex }];
    }
    if (
      item.type === "word_edit_ref" &&
      ((typeof item.editId === "string" && item.editId) ||
        (typeof item.edit_id === "string" && item.edit_id))
    ) {
      return [
        {
          ...event,
          type: "word_edit_ref",
          editId:
            typeof item.editId === "string"
              ? item.editId
              : (item.edit_id as string),
        },
      ];
    }
    if (item.type === "thinking") {
      return [
        {
          ...event,
          type: "thinking",
          ...(typeof item.isStreaming === "boolean"
            ? { isStreaming: item.isStreaming }
            : {}),
        },
      ];
    }

    return [event];
  });
}

export function messageFromStorage(
  message: SavedMessage,
  fallbackId: string,
): WordChatMessage {
  const id = message.id ?? fallbackId;
  if (message.role === "user") {
    return {
      id,
      role: "user",
      content: message.content,
      files: message.files,
      workflow: message.workflow,
      playbook: message.playbook,
      live: false,
    };
  }

  const events = normalizeStoredAssistantEvents(message.events ?? []);

  return {
    id,
    role: "assistant",
    files: message.files,
    workflow: message.workflow,
    events,
    ...(message.edits && message.edits.length > 0
      ? { edits: message.edits }
      : {}),
    ...(message.citations && message.citations.length > 0
      ? { citations: message.citations }
      : {}),
    live: false,
  };
}

export function assistantContent(message: WordAssistantMessage): string {
  return assistantContentFromEvents(message.events);
}

/** Longest excerpt of an edit's text a transcript summary line may carry. */
const TOOL_EDIT_SUMMARY_EXCERPT = 120;
/** Most summary lines one turn contributes to the replayed transcript. */
const TOOL_EDIT_SUMMARY_MAX_LINES = 20;

function excerpt(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > TOOL_EDIT_SUMMARY_EXCERPT
    ? `${collapsed.slice(0, TOOL_EDIT_SUMMARY_EXCERPT)}…`
    : collapsed;
}

function toolEditState(edit: WordDocumentEdit): string {
  if (edit.resolutionStatus) return edit.resolutionStatus;
  if (edit.applyStatus === "applied") return "applied";
  if (edit.applyStatus === "unmanaged") return "applied (unmanaged)";
  if (edit.applyStatus === "failed") {
    return `not applied${edit.errorCode ? ` (${edit.errorCode})` : ""}`;
  }
  return "awaiting the user's review";
}

/**
 * The model's own record of a prior turn's tool edits.
 *
 * Tool edits never appeared in the answer text, so replaying them as an
 * <EDITS> block would teach the model a protocol it must not use in this
 * mode — and would read as if it had emitted markup it never emitted. A
 * short factual summary keeps the transcript honest about what changed, what
 * is still waiting on the user, and what failed. It is bounded on both axes
 * because one 50-edit turn would otherwise plant an ever-replayed block in
 * every later request.
 */
function toolEditSummary(edits: WordDocumentEdit[]): string {
  const lines = edits
    .slice(0, TOOL_EDIT_SUMMARY_MAX_LINES)
    .map(
      (edit) =>
        `- "${excerpt(edit.originalText)}" → "${excerpt(edit.replacementText)}" — ${toolEditState(edit)}`,
    );
  const omitted = edits.length - lines.length;
  if (omitted > 0) lines.push(`- …and ${omitted} more`);
  return `[Edits sent to apply_word_edits in this response:\n${lines.join("\n")}\n]`;
}

/** Rehydrate normalized edit references only for the model's private history. */
export function assistantContentForModel(
  message: WordAssistantMessage,
): string {
  const editById = new Map((message.edits ?? []).map((edit) => [edit.id, edit]));
  const editByBlockIndex = new Map(
    (message.edits ?? []).map((edit) => [edit.blockIndex, edit]),
  );
  const chunks: string[] = [];
  let pendingEdits: Record<string, unknown>[] = [];
  let pendingToolEdits: WordDocumentEdit[] = [];
  const flushEdits = (): void => {
    if (pendingEdits.length > 0) {
      chunks.push(`<EDITS>\n${JSON.stringify(pendingEdits)}\n</EDITS>`);
      pendingEdits = [];
    }
    if (pendingToolEdits.length > 0) {
      chunks.push(toolEditSummary(pendingToolEdits));
      pendingToolEdits = [];
    }
  };
  const addEdit = (edit: WordDocumentEdit): void => {
    // The two channels split on the block-index space, which is exactly why
    // that space is disjoint: a tool edit replayed as <EDITS> would be a lie
    // about how it reached the document.
    if (isToolEditBlockIndex(edit.blockIndex)) {
      pendingToolEdits.push(edit);
      return;
    }
    pendingEdits.push({
      type: "edit_data",
      kind: "edit",
      deleted_text: edit.originalText,
      ...(edit.formats.length > 0
        ? { formats: edit.formats }
        : { inserted_text: edit.replacementText }),
      ...(edit.occurrence === "all" ? { occurrence: "all" } : {}),
      reason: edit.reason ?? "",
    });
  };
  for (const event of message.events) {
    if (isWordTextCardEvent(event)) {
      flushEdits();
      chunks.push(`${event.title}\n${event.text}`);
      continue;
    }
    if (isWordContentEvent(event)) {
      flushEdits();
      chunks.push(event.text);
      continue;
    }
    if (isWordEditReferenceEvent(event)) {
      const edit = editById.get(event.editId);
      if (edit) addEdit(edit);
      continue;
    }
    if (isWordEditBlockEvent(event)) {
      const edit = editByBlockIndex.get(event.blockIndex);
      if (edit) addEdit(edit);
      continue;
    }
    flushEdits();
  }
  flushEdits();
  return chunks.join("\n\n");
}

export function assistantContentFromEvents(
  events: WordAssistantEvent[],
): string {
  return events
    .flatMap((event) => (isWordContentEvent(event) ? [event.text] : []))
    .join("\n\n");
}

/**
 * Device-only chats do not pass through the backend finalizer. Normalize their
 * completed JSON edit blocks into prose plus deterministic edit references
 * before writing the assistant message to IndexedDB.
 */
export function normalizeLocalWordEditEvents(
  events: WordAssistantEvent[],
  messageId: string,
): WordAssistantEvent[] {
  const normalized: WordAssistantEvent[] = [];
  let blockOffset = 0;
  for (const event of events) {
    if (isWordEditBlockEvent(event)) {
      // Local edit rows are keyed by the same deterministic id, so the
      // reference resolves without a round trip (see createLocalWordDocumentEdit).
      normalized.push({
        type: "word_edit_ref",
        editId: `${messageId}:edit-${event.blockIndex}`,
      });
      continue;
    }
    if (!isWordContentEvent(event)) {
      normalized.push(event);
      continue;
    }
    const projection = projectRedlineStream(event.text);
    if (projection.edits.length === 0) {
      normalized.push(event);
      continue;
    }
    for (const segment of projection.segments) {
      if (segment.kind === "prose") {
        normalized.push({ ...event, type: "content", text: segment.text });
      } else if (segment.edit.sealed) {
        normalized.push({
          type: "word_edit_ref",
          editId: `${messageId}:edit-${blockOffset + segment.edit.blockIndex}`,
        });
      }
    }
    blockOffset += projection.blockCount;
  }
  return normalized;
}

export function assistantError(
  message: WordAssistantMessage,
): string | undefined {
  for (let index = message.events.length - 1; index >= 0; index--) {
    const event = message.events[index];
    if (event && isWordErrorEvent(event)) return event.message;
  }
  return undefined;
}

/** Append a delta to the current content segment, or start one after activity. */
export function appendAssistantContent(
  events: WordAssistantEvent[],
  text: string,
): WordAssistantEvent[] {
  const current = finalizeTrailingReasoning(
    events.filter((event) => !isWordThinkingEvent(event)),
  );
  const last = current[current.length - 1];
  if (last && isWordContentEvent(last)) {
    return [
      ...current.slice(0, -1),
      { ...last, type: "content", text: last.text + text },
    ];
  }
  return [...current, { type: "content", text, key: nextEventKey() }];
}

function finalizeTrailingReasoning(
  events: WordAssistantEvent[],
): WordAssistantEvent[] {
  const last = events[events.length - 1];
  if (!last || !isWordReasoningEvent(last) || !last.isStreaming) return events;
  const finalized: WordReasoningEvent = { ...last };
  delete finalized.isStreaming;
  return [...events.slice(0, -1), finalized];
}

/** Replace the generic placeholder with a real, streaming reasoning block. */
export function appendAssistantReasoning(
  events: WordAssistantEvent[],
  text: string,
): WordAssistantEvent[] {
  const current = events.filter((event) => !isWordThinkingEvent(event));
  const last = current[current.length - 1];
  if (last && isWordReasoningEvent(last) && last.isStreaming) {
    return [
      ...current.slice(0, -1),
      { ...last, type: "reasoning", text: last.text + text, isStreaming: true },
    ];
  }
  return [
    ...finalizeTrailingReasoning(current),
    { type: "reasoning", text, isStreaming: true, key: nextEventKey() },
  ];
}

/** Close the live reasoning block and bridge the gap to the next real event. */
export function finishAssistantReasoning(
  events: WordAssistantEvent[],
): WordAssistantEvent[] {
  const current = events.filter((event) => !isWordThinkingEvent(event));
  const last = current[current.length - 1];
  if (!last || !isWordReasoningEvent(last) || !last.isStreaming) {
    return current;
  }
  return [
    ...finalizeTrailingReasoning(current),
    { type: "thinking", isStreaming: true, key: nextEventKey() },
  ];
}

function documentReadIdentity(read: {
  filename: string;
  documentId?: string;
}): string {
  return read.documentId ?? `filename:${read.filename}`;
}

export function upsertDocumentReadEvent(
  events: WordAssistantEvent[],
  read: DocumentReadActivity,
): WordAssistantEvent[] {
  const current = finalizeTrailingReasoning(
    events.filter((event) => !isWordThinkingEvent(event)),
  );
  const identity = documentReadIdentity(read);
  const index = current.findIndex(
    (event) =>
      isWordDocumentReadEvent(event) &&
      documentReadIdentity(event) === identity,
  );
  const nextEvent: WordAssistantEvent = {
    type: "doc_read",
    filename: read.filename,
    ...(read.documentId ? { documentId: read.documentId } : {}),
    status: read.status,
  };

  if (index < 0) return [...current, { ...nextEvent, key: nextEventKey() }];
  const previous = current[index];
  if (
    previous &&
    isWordDocumentReadEvent(previous) &&
    previous.status === "read" &&
    read.status === "reading"
  ) {
    return current;
  }
  return current.map((event, eventIndex) =>
    eventIndex === index
      ? {
          ...nextEvent,
          ...(typeof previous?.key === "string" ? { key: previous.key } : {}),
        }
      : event,
  );
}

export function setAssistantError(
  events: WordAssistantEvent[],
  message: string,
): WordAssistantEvent[] {
  const current = finalizeTrailingReasoning(
    events.filter(
      (event) => !isWordErrorEvent(event) && !isWordThinkingEvent(event),
    ),
  );
  return [...current, { type: "error", message, key: nextEventKey() }];
}

export function completeAssistantEvents(
  events: WordAssistantEvent[],
): WordAssistantEvent[] {
  const completed = events.filter(
    (event) =>
      !isWordThinkingEvent(event) &&
      !(isWordDocumentReadEvent(event) && event.status === "reading"),
  );
  return finalizeTrailingReasoning(completed);
}
