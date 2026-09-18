import type { AssistantEvent as WireAssistantEvent } from "@mike/contracts";
/** API contracts used by the Word task pane. */

export interface LibraryFolder {
  id: string;
  name: string;
  parent_folder_id: string | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  cm_number: string | null;
  created_at: string;
  document_count?: number;
}

export interface Document {
  id: string;
  workflow_id?: string | null;
  folder_id?: string | null;
  library_folder_id?: string | null;
  filename: string;
  file_type: string | null;
  size_bytes: number | null;
  created_at: string | null;
}

export interface Chat {
  id: string;
  project_id: string | null;
  user_id: string;
  title: string | null;
  model?: string | null;
  reasoning_level?: import("./lib/wordChatTypes").ReasoningLevel | null;
  created_at: string;
}

/** A document read the model completed during an assistant turn. */
export interface DocumentReadActivity {
  filename: string;
  /** Stable for stored documents; absent for the request-scoped active document. */
  documentId?: string;
  status: "reading" | "read";
}

export type WordThinkingEvent = {
  type: "thinking";
  isStreaming?: boolean;
  /** Stable render identity assigned at creation; see wordChatEvents.ts. */
  key?: string;
};

export type WordReasoningEvent = Extract<
  WireAssistantEvent,
  { type: "reasoning" }
> & { isStreaming?: boolean; key?: string };

export type WordContentEvent = Extract<
  WireAssistantEvent,
  { type: "content" }
> & { isStreaming?: boolean; key?: string };

export type WordDocumentReadEvent = {
  type: "doc_read";
  filename: string;
  documentId?: string;
  status: DocumentReadActivity["status"];
  key?: string;
};

export type WordErrorEvent = Extract<WireAssistantEvent, { type: "error" }> & {
  key?: string;
};

/** Exact placement of a normalized edit card within assistant event history. */
export type WordEditReferenceEvent = {
  type: "word_edit_ref";
  editId: string;
  key?: string;
};

/**
 * Placement of a tool-proposed edit card, keyed by block index rather than
 * row id.
 *
 * A live turn learns an edit exists the moment the backend forwards the tool
 * call — before the canonical row (and therefore its id) exists. The backend
 * finalizer replaces this marker with a `word_edit_ref` in cloud history and
 * `normalizeLocalWordEditEvents` does the same for device-only chats, so it
 * only ever appears mid-turn.
 */
export type WordEditBlockEvent = {
  type: "word_edit_block";
  blockIndex: number;
  key?: string;
};

export type { WordDocumentEdit } from "@mike/contracts";
import type { WordDocumentEdit } from "@mike/contracts";

/**
 * A backend-persisted assistant activity the Word surface does not render yet.
 *
 * The web assistant stores its event array directly in the message `content`
 * column. Keep the same JSON object here instead of discarding activity types
 * the smaller Word renderer does not understand. Rendering remains explicitly
 * allow-listed through the guards in `lib/wordChatEvents.ts`.
 */
export interface WordAssistantStoredEvent {
  type: string;
  [field: string]: unknown;
}

/** Durable and live assistant events, retained in their original order. */
export type WordAssistantEvent =
  | WordThinkingEvent
  | WordReasoningEvent
  | WordContentEvent
  | WordDocumentReadEvent
  | WordErrorEvent
  | WordEditReferenceEvent
  | WordEditBlockEvent
  | WordAssistantStoredEvent;

/**
 * One backend citation: the shared chat pipeline emits `[n]` markers in the
 * answer and a citations array carrying each marker's verbatim quote. Only
 * the fields the pane needs are typed; rows pass through storage unchanged.
 */
export interface WordCitation {
  ref?: number | null;
  marker?: string | null;
  quote?: string | null;
  text?: string | null;
  quotes?: { quote?: string | null; text?: string | null }[] | null;
}

export type { WordEditResolutionStatus } from "@mike/contracts";

export interface Message {
  id?: string;
  role: "user" | "assistant";
  content: string;
  files?: { filename: string; document_id?: string }[];
  workflow?: { id: string; title: string };
  /** Assistant turns preserve their content and activity in event order. */
  events?: WordAssistantEvent[];
  /** Canonical normalized edits for this assistant message. */
  edits?: WordDocumentEdit[];
  /** Assistant turns only: quotes behind the answer's `[n]` markers. */
  citations?: WordCitation[];
}

export interface Workflow {
  id: string;
  metadata: {
    title: string;
    type: "assistant" | "tabular";
    language: string | null;
    practice: string | null;
    jurisdictions: string[] | null;
  };
  skill_md: string | null;
  is_system: boolean;
  is_default?: boolean;
  default_key?: string | null;
  allow_edit?: boolean;
}

export interface QuickAction {
  id: string;
  workflow_id: string;
  name?: string | null;
  prompt: string;
  document_upload: boolean;
  surface: "app" | "word";
  enabled: boolean;
  sort_order: number;
  workflow: { id: string; title: string };
}

/**
 * Which model providers have a usable API key for the signed-in user, and
 * where each key comes from. Lives here (not in api/client.ts) because
 * frontend/src/wordAddin imports it across packages for parity tests and
 * must not drag the API client's runtime dependencies into the web app's
 * type-check.
 */
export interface ApiKeyStatus {
  claude: boolean;
  gemini: boolean;
  openai: boolean;
  openrouter: boolean;
  vercel: boolean;
  "opencode-go": boolean;
  courtlistener: boolean;
  sources?: Partial<
    Record<
      | "claude"
      | "gemini"
      | "openai"
      | "openrouter"
      | "vercel"
      | "opencode-go"
      | "courtlistener",
      "user" | "env" | null
    >
  >;
}
