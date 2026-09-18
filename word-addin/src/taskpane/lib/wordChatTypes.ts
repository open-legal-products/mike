import type {
  Message as SavedMessage,
  WordAssistantEvent,
  WordDocumentEdit,
} from "../types";
import type { RedlineEdit } from "./redline";

export type WordChatStorageMode = "cloud" | "local";
export type WorkflowAttachment = { id: string; title: string };
export type ReasoningLevel =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type EditDecision = "accept" | "reject";
export type EditBusyAction =
  | "view"
  | "apply"
  | "accept"
  | "reject"
  | "accept-and-apply";

export type EditCardStatus =
  | "receiving"
  | "validating"
  | "applying"
  | "applying-approved"
  | "restoring"
  | "ready"
  | "pending"
  | "view-only"
  | "applied"
  | "accepted"
  | "rejected"
  | "skipped"
  | "ambiguous"
  | "unsearchable"
  | "conflicted"
  /** Skipped because the document already carries this exact edit. */
  | "already-applied"
  /** Word faulted mid-apply and nothing could prove whether it landed. */
  | "unverified"
  | "incomplete"
  | "unmanaged"
  | "error"
  | "historical";

export interface EditRuntimeState {
  status: EditCardStatus;
  matches?: number;
  /** How many occurrences a replace-all edit actually applied. */
  appliedMatches?: number;
  /** Snippet of the paragraph the edit landed in, for wrong-place review. */
  locationHint?: string;
  error?: string;
  /** Navigation failures do not change the tracked edit's lifecycle. */
  viewError?: string;
  busy?: boolean;
  /** Identifies the control whose in-flight operation should show progress. */
  busyAction?: EditBusyAction;
}

interface RuntimeMessageBase {
  id: string;
  files?: SavedMessage["files"];
  workflow?: SavedMessage["workflow"];
  /** Only the current streamed turn may mutate the live Word document. */
  live?: boolean;
}

export interface WordUserMessage extends RuntimeMessageBase {
  role: "user";
  content: string;
}

export interface WordAssistantMessage extends RuntimeMessageBase {
  role: "assistant";
  /** Canonical assistant content and activity, in arrival order. */
  events: WordAssistantEvent[];
  /** Canonical edit rows hydrated by cloud or device-only storage. */
  edits?: WordDocumentEdit[];
  /** Quotes behind the answer's `[n]` markers, from the backend pipeline. */
  citations?: SavedMessage["citations"];
}

export type WordChatMessage = WordUserMessage | WordAssistantMessage;

export interface WordChatSubmission {
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: WorkflowAttachment;
  model: string;
  reasoning: ReasoningLevel;
}

export interface WordChatSubmitOptions {
  /** Called only after the document snapshot succeeds and the turn exists. */
  onAccepted?: () => void;
  /** Places the new turn after React has rendered its empty assistant slot. */
  onTurnReady?: () => void;
}

/**
 * Per-edit outcome of one apply_word_edits tool call, in request order.
 * `index` is the position within that call's edits array; the status
 * vocabulary is the wire contract with the backend's normalizeEditOutcomes.
 *
 * "proposed" is Review mode's success: the edit was validated against the
 * live document and its card is waiting on the user's Apply click. Only
 * "applied"/"applied-unmanaged" mean the document actually changed.
 */
export interface WordToolEditOutcome {
  index: number;
  status:
    | "applied"
    /** Applied as a real tracked change; the add-in lost review controls. */
    | "applied-unmanaged"
    /** Validated, card ready, awaiting the user's approval. */
    | "proposed"
    | "not-found"
    | "ambiguous"
    | "skipped"
    | "error";
  matches?: number;
  /** Word's skip reason ("pre-existing-revisions", "unsearchable", …). */
  reason?: string;
  error?: string;
}

/** One edit of an apply_word_edits batch with its message-wide block index. */
export interface WordToolEditItem {
  /**
   * Position in the message's edit key space (see getToolEditKey). Derived
   * from the edit's REQUESTED index in the tool input, so the pane, the
   * backend's persisted markers, and history restore all count the same
   * thing even if a row was rejected client-side.
   */
  blockIndex: number;
  edit: RedlineEdit;
}

export interface WordEditStreamController {
  processLiveRedlines: (
    messageId: string,
    content: string,
    persistent: boolean,
  ) => void;
  markIncompleteRedlines: (messageId: string, content: string) => void;
  /**
   * Run one apply_word_edits batch through the normal card lifecycle and
   * report what happened, so the caller can post the truth back to the
   * backend tool loop. Review mode validates and settles each card on
   * "ready" (outcome "proposed"); Edit mode applies the tracked change.
   * Returned outcomes are positional with `items`.
   */
  applyToolEdits: (
    messageId: string,
    items: WordToolEditItem[],
    persistent: boolean,
  ) => Promise<WordToolEditOutcome[]>;
  waitForMessageEdits: (messageId: string) => Promise<void>;
}

export interface WordTrackedEditsController {
  editStateByKey: Readonly<Record<string, EditRuntimeState>>;
  /**
   * Streaming-facing behavior with a render-stable identity. It is memoized
   * apart from `editStateByKey` so that hooks depending on it (handleChat)
   * are not recreated by every edit-state transition during a stream.
   */
  streamController: WordEditStreamController;
  /** Apply a validated Review-mode proposal as a tracked Word change. */
  applyEdit: (key: string) => void;
  viewEdit: (key: string) => Promise<void>;
  resolveOneEdit: (key: string, decision: EditDecision) => Promise<void>;
  resolveMessageEdits: (
    editKeys: string[],
    decision: EditDecision,
  ) => Promise<void>;
  /**
   * Conflicted-card action: accept the pending tracked changes occupying
   * the edit's target passage, then apply the edit as a fresh redline.
   */
  acceptAndApplyEdit: (key: string) => Promise<void>;
}

export type PersistWordDocumentEdit = (
  messageId: string,
  blockIndex: number,
  edit: RedlineEdit,
  applyMode: "direct" | "approval",
) => Promise<WordDocumentEdit>;

export interface PersistedWordEditPatch {
  apply_status?: "proposed" | "applied" | "unmanaged" | "failed";
  resolution_status?: "accepted" | "rejected";
  matched_occurrences?: number;
  applied_occurrences?: number;
  error_code?: string | null;
  error_message?: string | null;
}

export type UpdatePersistedWordDocumentEdit = (
  messageId: string,
  blockIndex: number,
  patch: PersistedWordEditPatch,
) => Promise<void>;

export interface WordAssistantChatController {
  messages: WordChatMessage[];
  isResponseLoading: boolean;
  requestError: string | null;
  handleChat: (
    submission: WordChatSubmission,
    options?: WordChatSubmitOptions,
  ) => Promise<void>;
  cancel: () => void;
  dismissRequestError: () => void;
  /** Resend the last turn the user submitted, for a "Retry" on a failure. */
  retryLastMessage: () => void;
}
