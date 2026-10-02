// Authored wire contracts. No server, browser, UI or storage dependencies.

export type SourceDocumentType =
  | "docx"
  | "pdf"
  | "spreadsheet"
  | "case"
  | "legislation";

export type SourceDocumentMetadata = {
  label: string;
  value: string;
  format?: "date";
};

export type SourceDocumentAction = {
  type: "download" | "link";
  url: string;
  label: string;
  title?: string;
};

export type SourceDocumentQuote = {
  quote: string;
  verification?: {
    verified: boolean;
    source_excerpt?: string;
    start_char?: number;
    end_char?: number;
  };
  target: {
    page?: number | string;
    sheet?: string;
    cell?: string;
    subdocument_id?: string;
  };
};

export type SourceSubdocument = {
  document_id: string;
  title: string;
  type: "html";
  html?: string | null;
  text?: string | null;
};

export type SourceDocument = {
  document_id: string;
  title: string;
  type: SourceDocumentType;
  metadata: SourceDocumentMetadata[];
  actions?: SourceDocumentAction[];
  quotes: SourceDocumentQuote[];
  subdocuments?: SourceSubdocument[];
  version_id?: string | null;
  version_number?: number | null;
};

/**
 * Per-quote verification result. `start_char`/`end_char` index into the
 * EXTRACTED source text (not the raw file bytes) and are only present for
 * single-segment quotes that matched.
 */
export type QuoteVerification = {
  verified: boolean;
  start_char?: number;
  end_char?: number;
  source_excerpt?: string;
};

// ---------------------------------------------------------------------------
// Event / annotation types (shared between toolDispatcher and streaming)
// ---------------------------------------------------------------------------

export type AskInputOption = {
  value: string;
};

export type AskInputItem =
  | {
      id: string;
      kind: "choice";
      question: string;
      options: AskInputOption[];
      allow_other: boolean;
      other_label: string;
      response_prefix?: string;
    }
  | {
      id: string;
      kind: "multi_choice";
      question: string;
      options: AskInputOption[];
      allow_other: boolean;
      other_label: string;
      response_prefix?: string;
    }
  | {
      id: string;
      kind: "text";
      question: string;
      response_prefix?: string;
    }
  | {
      id: string;
      kind: "documents";
      document_types: string[];
      response_prefix?: string;
    }
  | ConnectorApprovalItem;

/**
 * A connector write the server paused for the user's approval. The server
 * creates these items, never the model's ask_inputs tool, and on approval it
 * runs the stored `action` from the persisted event — the client supplies
 * only the decision.
 */
export type ConnectorApprovalItem = {
  id: string;
  kind: "approval";
  connector_name: string;
  /** Tool name as the model called it. */
  tool_name: string;
  /** Human-readable action label, e.g. "Send email". */
  title: string;
  /** Arguments that run on approval, shown for review. */
  arguments: Record<string, unknown>;
  /** Current state the action changes, when the connector can read it. */
  before?: unknown;
  /** Account the action runs as, when known. */
  account?: string;
  /** Server-side binding to the connection that was reviewed. */
  binding: ConnectorApprovalBinding;
};

export type ConnectorApprovalBinding =
  | {
      type: "mcp";
      connector_id: string;
      tool_id: string;
      /** Absent on legacy approvals, which must be reviewed again. */
      connection_fingerprint?: string;
    }
  | {
      type: "google";
      provider: GoogleWorkspaceProvider | "google-drive";
      grant_id: string;
      etag?: string;
    };

export type AskInputsEvent = {
  type: "ask_inputs";
  /** Stable identity for this particular prompt within its assistant message. */
  event_id: string;
  items: AskInputItem[];
};

export type AskInputResponseItem =
  | {
      id: string;
      kind: "choice";
      question: string;
      answer?: string;
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "multi_choice";
      question: string;
      answers?: string[];
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "text";
      question: string;
      answer?: string;
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "documents";
      filenames: string[];
      skipped?: boolean;
    }
  | {
      id: string;
      kind: "approval";
      decision: "approve" | "reject";
    };

export type AskInputsResponseRequest = {
  /** Durable assistant row that contains the unanswered ask_inputs event. */
  assistant_message_id: string;
  /** The exact ask_inputs event being answered. */
  ask_event_id: string;
  responses: AskInputResponseItem[];
};

export type EditAnnotation = {
  kind: "edit";
  edit_id: string;
  document_id: string;
  version_id: string;
  version_number?: number | null;
  change_id: string;
  del_w_id?: string;
  ins_w_id?: string;
  deleted_text: string;
  inserted_text: string;
  context_before: string;
  context_after: string;
  reason?: string;
  status: "pending" | "accepted" | "rejected";
};

export type CourtlistenerToolEvent =
  | {
      type: "courtlistener_search_case_law";
      query: string;
      result_count: number;
      error?: string;
    }
  | {
      type: "courtlistener_get_cases";
      cluster_ids: number[];
      case_count: number;
      opinion_count: number;
      cases?: {
        cluster_id: number;
        case_name: string | null;
        citation: string | null;
        dateFiled?: string | null;
        url?: string | null;
      }[];
      error?: string;
    }
  | {
      type: "courtlistener_find_in_case";
      cluster_id: number | null;
      query: string;
      total_matches: number;
      case_name?: string | null;
      citation?: string | null;
      searches?: {
        cluster_id: number | null;
        query: string;
        total_matches: number;
        case_name?: string | null;
        citation?: string | null;
        error?: string;
      }[];
      error?: string;
    }
  | {
      type: "courtlistener_read_case";
      cluster_id: number | null;
      case_name?: string | null;
      citation?: string | null;
      opinion_count: number;
      error?: string;
    }
  | {
      type: "courtlistener_verify_citations";
      citation_count: number;
      match_count: number;
      error?: string;
    };

export type CaseCitationEvent = {
  type: "case_citation";
  cluster_id: number | null;
  case_name: string | null;
  citation: string | null;
  url: string;
  pdfUrl?: string | null;
  dateFiled?: string | null;
  document: SourceDocument;
};

export type McpToolEvent = {
  type: "mcp_tool_call";
  connector_id: string;
  connector_name: string;
  tool_name: string;
  openai_tool_name: string;
  status: "ok" | "error";
  error?: string;
  /** The approval item this call ran for, when it needed the user's approval. */
  approval_id?: string;
  /** Bounded tool output replayed to the model after an approved call. */
  result?: string;
};

export type AssistantEvent =
  | { type: "reasoning"; text: string }
  | AskInputsEvent
  | {
      type: "ask_inputs_response";
      assistant_message_id: string;
      ask_event_id: string;
      responses: AskInputResponseItem[];
      /** User who supplied this continuation, for scoped-memory attribution. */
      author_user_id?: string;
      /** Immutable evidence time used by memory wipe/enable cutoffs. */
      recorded_at?: string;
    }
  | {
      type: "doc_read";
      filename: string;
      document_id?: string;
      version_id?: string | null;
      version_number?: number | null;
    }
  | {
      type: "doc_find";
      filename: string;
      document_id?: string;
      version_id?: string | null;
      version_number?: number | null;
      query: string;
      total_matches: number;
    }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
      type: "doc_replicated";
      /** Source document being copied. */
      filename: string;
      count: number;
      copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
      }[];
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      /** Per-document monotonic Vn; null if backend couldn't determine it. */
      version_number: number | null;
      download_url: string;
      annotations: EditAnnotation[];
    }
  | CaseCitationEvent
  | CourtlistenerToolEvent
  | McpToolEvent
  | {
      type: "case_opinions";
      cluster_id: number;
      document: SourceDocument;
    }
  | { type: "content"; text: string }
  | {
      /**
       * Placement marker for one edit a client tool proposed, spliced into
       * the event stream exactly where the tool call landed between content
       * blocks. `persistWordDocumentEdits` upserts it into the canonical
       * `word_document_edits` row and swaps it for a `word_edit_ref` — the
       * same normalization the `<EDITS>` protocol's blocks go through, so
       * both channels produce identical persisted history.
       */
      type: "word_edit_block";
      block_index: number;
      original_text: string;
      replacement_text: string;
      formats: string[];
      occurrence: "all" | null;
      reason: string | null;
    }
  | {
      type: "error";
      message: string;
      safe_to_display?: boolean;
      /**
       * Machine-readable cause, when the client can offer a specific remedy.
       * "invalid_api_key": the provider rejected the caller's key.
       */
      code?: AssistantErrorCode;
    };

export type AssistantErrorCode = "invalid_api_key";

export type WordEditApplyMode = "direct" | "approval";

export interface WordDocumentEdit {
  id: string;
  messageId: string;
  blockIndex: number;
  originalText: string;
  replacementText: string;
  formats: string[];
  occurrence?: "all";
  reason?: string;
  applyMode: "direct" | "approval";
  applyStatus: "proposed" | "applied" | "unmanaged" | "failed";
  resolutionStatus?: WordEditResolutionStatus;
  matchedOccurrences?: number;
  appliedOccurrences?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type WordEditResolutionStatus = "accepted" | "rejected";

/** Explicit Google service connections are independent of Mike sign-in. */
export type GoogleWorkspaceProvider = 'gmail' | 'google-calendar';
export interface GoogleDriveStatus {
    configured: boolean;
    schemaReady?: boolean;
    connected: boolean;
    scope: string | null;
    enabled: boolean;
    /** Full Drive permission was granted and connection binding is available. */
    writeEnabled: boolean;
    requireWriteApproval: boolean;
    /** Disables write tools while preserving individual tool choices. */
    readOnly?: boolean;
    grantId?: string;
    /** Absent for connections made before the account was recorded. */
    accountEmail?: string;
    tools: NativeConnectorTool[];
    redirectUri?: string | null;
}
export interface GoogleWorkspaceStatus {
    configured: boolean;
    schemaReady: boolean;
    connected: boolean;
    /** Google granted write access; false when the user or an admin withheld it. */
    writeEnabled: boolean;
    /** Whether the assistant may use this connection at all. */
    enabled: boolean;
    /** Whether each write action waits for the user's approval in the conversation. */
    requireWriteApproval: boolean;
    /** Disables write tools while preserving individual tool choices. */
    readOnly?: boolean;
    tools: NativeConnectorTool[];
    grantId?: string;
    accountEmail?: string;
    redirectUri: string | null;
}
/** A built-in connector tool and whether the user has switched it on. */
export interface NativeConnectorTool {
    name: string;
    title: string;
    description: string;
    write: boolean;
    enabled: boolean;
}
