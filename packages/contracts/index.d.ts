// Authored wire contracts. No server, browser, UI or storage dependencies.

export type TabularReviewHistoryStatus = {
  id: string;
  is_running: boolean;
  is_complete: boolean;
};

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
  /** Title of the delegated task that asked for this action, if a subagent did. */
  requested_by?: string;
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
  /** Human-readable tool label from the connector, when it provides one. */
  tool_title?: string;
  openai_tool_name: string;
  status: "ok" | "error";
  error?: string;
  /** The approval item this call ran for, when it needed the user's approval. */
  approval_id?: string;
  /** Bounded tool output replayed to the model after an approved call. */
  result?: string;
};

export type WebSource = { url: string; title?: string };

export type WebToolErrorCode =
  /** Mike's search has no key for the chosen search service. */
  | "not_configured"
  /** The search API refused the key: invalid, or its plan does not cover the request. */
  | "rejected"
  /** No search backend could run, or the model provider refused its own search. */
  | "unavailable"
  /** The page could not be read: a blocked address, an unsupported type, a failed fetch. */
  | "unreadable"
  | "failed";

/**
 * Web activity in a turn. A search done by the model provider and one done
 * by Mike's own search look the same.
 */
export type WebToolEvent =
  | {
      type: "web_search";
      search_id: string;
      query: string;
      results: WebSource[];
      error?: string;
      error_code?: WebToolErrorCode;
    }
  | {
      type: "web_read";
      read_id: string;
      url: string;
      title?: string;
      error?: string;
      error_code?: WebToolErrorCode;
    }
  /** Pages the answer cites, as reported by the model provider. */
  | { type: "web_sources"; sources: WebSource[] };

export type DelegationEffort = "quick" | "standard" | "deep";
export type DelegationModelTier = "light" | "standard" | "same";

/**
 * One delegated task: a subagent's own steps and the brief it returned to the
 * assistant. The brief keeps the subagent's citation markers; the assistant
 * re-cites anything it relies on.
 */
export type DelegationEvent = {
  type: "delegation";
  delegation_id: string;
  continued_from?: string;
  title: string;
  task: string;
  /**
   * `incomplete`: stopped by its time or token budget; the brief is partial.
   * `needs_input`: paused to ask `question` or for `approval_ids`.
   */
  status: "completed" | "incomplete" | "needs_input" | "failed" | "cancelled";
  brief?: string;
  question?: string;
  /** Approval items, held by the answer, that this paused subagent waits on. */
  approval_ids?: string[];
  events: AssistantEvent[];
  model: string;
  effort: DelegationEffort;
  /** The reasoning level the subagent ran at. Older runs did not record it. */
  reasoning?: string;
  /** The tokens its effort allowed. Older runs did not record it. */
  token_budget?: number;
  usage?: { input_tokens: number; output_tokens: number };
};

/**
 * What an answer ran on, sent once at its end: the model, the reasoning level
 * it was asked for, and the tokens the assistant itself used (each subagent
 * reports its own on its delegation event). Shown only when the user turns on
 * Settings > Features > Response details.
 */
export type ResponseDetailsEvent = {
  type: "response_details";
  model: string;
  reasoning?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

export type DocumentSearchErrorCode =
  | "schema_out_of_date"
  | "invalid_search"
  | "search_timeout"
  | "search_unavailable"
  | "internal_error";

/** One scoped text search; counts describe this page, not every matching document. */
export type DocumentSearchEvent = {
  type: "doc_search";
  search_id: string;
  scope: string;
  query: string;
  offset: number;
  match_count?: number;
  next_offset?: number | null;
  coverage?: {
    total_versions: number;
    indexed_versions: number;
    pending_versions: number;
    failed_versions: number;
    versions_needing_ocr: number;
  };
  /** Safe, user-facing failure message. No result count is supplied on failure. */
  error?: string;
  error_code?: DocumentSearchErrorCode;
};

export type TextCardEvent = {
  type: "text_card";
  card_id: string;
  title: string;
  /** Literal, copy-ready text. Whitespace and line breaks are significant. */
  text: string;
};

export type AssistantEvent =
  | TextCardEvent
  | DocumentSearchEvent
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
  | WebToolEvent
  | DelegationEvent
  | ResponseDetailsEvent
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
    /**
     * False when the operator switched Drive off for the deployment
     * (GOOGLE_WORKSPACE_DISABLED_PROVIDERS): Discover does not offer it, new
     * connections and Picker sessions are refused, and the assistant has none
     * of its tools.
     */
    available: boolean;
    schemaReady?: boolean;
    connected: boolean;
    scope: string | null;
    enabled: boolean;
    /** A Drive write scope (drive.file or legacy full drive) was granted and connection binding is available. */
    writeEnabled: boolean;
    requireWriteApproval: boolean;
    /** Disables write tools while preserving individual tool choices. */
    readOnly?: boolean;
    grantId?: string;
    /** Absent for connections made before the account was recorded. */
    accountEmail?: string;
    /**
     * Add files from Google Drive can be offered: the server has the Picker's
     * browser key and app id, and the connection (if any) holds the per-file
     * drive.file scope rather than a legacy whole-Drive one.
     */
    pickerAvailable: boolean;
    tools: NativeConnectorTool[];
    redirectUri?: string | null;
}
/** What the browser needs to open the Google Picker; never a refresh token. */
export interface GoogleDrivePickerSession {
    /** Short-lived drive.file access token. */
    accessToken: string;
    expiresAt: string;
    /** Google Cloud project number; picked files are granted to this app. */
    appId: string;
    /** Browser API key restricted to the Google Picker and Google Drive APIs. */
    developerKey: string;
}
export interface GoogleWorkspaceStatus {
    configured: boolean;
    /**
     * False when the operator switched this service off for the deployment
     * (GOOGLE_WORKSPACE_DISABLED_PROVIDERS): Discover does not offer it, new
     * connections are refused, and the assistant has none of its tools.
     */
    available: boolean;
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
/** The CourtListener connector in one workspace (GET /user/integrations/courtlistener). */
export interface CourtListenerConnectorStatus {
    /** The workspace's on/off switch for US case law research. */
    enabled: boolean;
    /**
     * Listed under Installed: switched on with a usable token here (the
     * user's or the organization's) or the deployment's bulk index, or the
     * user has saved their own token here. Otherwise it is offered in Discover.
/**
 * Feature flags (Settings → Admin). The list of flags lives in
 * backend/src/lib/featureFlags.ts; a flag answers "is this on for this user?"
 * from the user's override, else the deployment default, else the code
 * default. Each Google scope bundle is its own flag.
 */
export type FeatureFlagKey =
    | 'google-drive'
    | 'gmail-read'
    | 'gmail-write'
    | 'google-calendar-read'
    | 'google-calendar-write';
export interface FeatureFlagSummary {
    key: FeatureFlagKey;
    label: string;
    description: string;
    /** Flags shown together in the admin panel. */
    group: string;
    /** What applies when no admin default is set; may read server configuration. */
    codeDefault: boolean;
    /** Set by an admin for the whole deployment; null means the code default applies. */
    deploymentDefault: boolean | null;
    effectiveDefault: boolean;
}
/** GET /admin/feature-flags and the body PUT /admin/feature-flags/:key answers with. */
export interface AdminFeatureFlagsResponse {
    flags: FeatureFlagSummary[];
}
/** GET /admin/users/feature-flags?email= and the body PUT /admin/users/:userId/feature-flags/:key answers with. */
export interface AdminUserFeatureFlags {
    userId: string;
    email: string;
    displayName: string | null;
    flags: Array<{
        key: FeatureFlagKey;
        /** Set by an admin for this user; null means the deployment default applies. */
        override: boolean | null;
        enabled: boolean;
    }>;
}
     */
    installed: boolean;
    /** The user saved their own token for this workspace. */
    ownToken: boolean;
    /** Whose token lookups run on: the user's own or their organization's. */
    tokenSource: "user" | "org" | null;
    /** The deployment answers lookups from its bulk index. */
    bulkData: boolean;
}
/** A built-in connector tool and whether the user has switched it on. */
export interface NativeConnectorTool {
    name: string;
    title: string;
    description: string;
    write: boolean;
    enabled: boolean;
}

/** Organization departure preview: only public transfer items expose titles. */
export interface OrgMemberHandover {
    sharedChats: number;
    sharedReviews: number;
    sharedDocuments: number;
    projects: { id: string; title: string }[];
    workflows: { id: string; title: string }[];
    privateProjects: number;
    privateWorkflows: number;
    chats: number;
    reviews: number;
    documents: number;
}

export type OrgPrivateContentKind = "project" | "workflow" | "chat" | "tabular_review" | "document";
export interface OrgPrivateContentItem {
    kind: OrgPrivateContentKind;
    item_id: string;
    title: string | null;
    user_id: string | null;
    display_name: string | null;
    email: string | null;
    has_access: boolean;
}
export interface OrgPrivateContentPage {
    items: OrgPrivateContentItem[];
    nextOffset: number | null;
}

/** Owner-only recovery list; these items are excluded from normal access. */
export interface OrgDepartureArchive {
    id: string;
    kind: "project" | "workflow" | "chat" | "tabular_review" | "document";
    item_id: string;
    title: string;
    archived_at: string;
    expires_at: string;
}
export interface OrgDepartureArchivePage {
    items: OrgDepartureArchive[];
    nextOffset: number | null;
}
/** An archived item as the Departed members view lists it. */
export interface OrgDepartureItem extends OrgDepartureArchive {
    /** What a project or workflow holds; absent for the other kinds. */
    contents?: { documents: number; chats: number; tabular_reviews: number };
}
/** The archived work one member left behind when they departed. */
export interface OrgDeparture {
    /** Identifies the departure for as long as any of its work is archived. */
    key: string;
    /** Null once the departed account has been deleted. */
    member: {
        user_id: string;
        display_name: string | null;
        email: string | null;
    } | null;
    departed_at: string;
    /** When the earliest of its items is permanently deleted. */
    expires_at: string;
    items: OrgDepartureItem[];
}
/** Soonest deletion first. `truncated` when there was more than is listed. */
export interface OrgDepartureList {
    departures: OrgDeparture[];
    truncated: boolean;
}
/** `unresolved` items could not be reassigned or deleted and are still archived. */
export interface OrgDepartureResolution {
    resolved: number;
    unresolved: number;
}

/** A team organization still inside its owner-only recovery period. */
export interface DeletedOrganization {
    id: string;
    name: string;
    deleted_at: string;
    purge_after: string;
}

/** An identity visible in an authorized organization's audit history. */
export interface AuditActor {
  user_id: string;
  email: string | null;
  display_name: string | null;
  profile_photo: string | null;
}

export interface AuditActorPage {
  users: AuditActor[];
  nextOffset: number | null;
}
