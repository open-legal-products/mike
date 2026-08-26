// Shared TypeScript types for Mike AI legal assistant

import type {
    SourceDocument,
    SourceDocumentAction,
    SourceDocumentMetadata,
    SourceDocumentQuote,
    SourceDocumentType,
    SourceSubdocument,
} from "../../../../../backend/src/lib/sourceDocuments";
import type {
    AskInputItem as SharedAskInputItem,
    AskInputResponseItem as SharedAskInputResponseItem,
    AskInputsEvent as SharedAskInputsEvent,
} from "../../../../../backend/src/lib/chat/types";

export interface Folder {
    id: string;
    project_id: string;
    user_id: string;
    name: string;
    parent_folder_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface LibraryFolder {
    id: string;
    user_id: string;
    library_kind: "file" | "template";
    name: string;
    parent_folder_id: string | null;
    created_at: string;
    updated_at: string;
}

export interface Project {
    id: string;
    user_id: string;
    is_owner?: boolean;
    owner_display_name?: string | null;
    owner_email?: string | null;
    name: string;
    cm_number: string | null;
    practice: string | null;
    shared_with: string[];
    created_at: string;
    updated_at: string;
    documents?: Document[];
    folders?: Folder[];
    document_count?: number;
    chat_count?: number;
    review_count?: number;
}

export interface Document {
    id: string;
    user_id?: string;
    project_id: string | null;
    folder_id?: string | null;
    library_kind?: "file" | "template";
    library_folder_id?: string | null;
    filename: string;
    owner_email?: string | null;
    owner_display_name?: string | null;
    file_type: string | null; // pdf | docx | doc | xlsx | xlsm | xls | pptx | ppt
    storage_path: string | null;
    pdf_storage_path: string | null;
    size_bytes: number | null;
    page_count: number | null;
    structure_tree: StructureNode[] | null;
    status: "pending" | "processing" | "ready" | "error";
    created_at: string | null;
    updated_at?: string | null;
    /** Stable id of the document version currently selected for this row. */
    current_version_id?: string | null;
    /** Version number of the document row pointed to by current_version_id. */
    active_version_number?: number | null;
    /** Legacy: max version_number across assistant_edit rows, null if doc is unedited. */
    latest_version_number?: number | null;
}

export type PanelDocumentType = SourceDocumentType;
export type PanelDocumentMetadata = SourceDocumentMetadata;
export type PanelDocumentAction = SourceDocumentAction;
export type PanelDocumentQuote = SourceDocumentQuote;
export type PanelSubdocument = SourceSubdocument;
export type PanelDocument = SourceDocument;

export function isPanelDocument(value: unknown): value is PanelDocument {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const document = value as Record<string, unknown>;
    return (
        typeof document.document_id === "string" &&
        typeof document.title === "string" &&
        ["docx", "pdf", "spreadsheet", "case", "legislation"].includes(
            String(document.type),
        ) &&
        Array.isArray(document.metadata) &&
        Array.isArray(document.quotes) &&
        (document.actions === undefined || Array.isArray(document.actions)) &&
        (document.subdocuments === undefined ||
            Array.isArray(document.subdocuments))
    );
}

export interface StructureNode {
    id: string;
    title: string;
    level: number;
    page_number: number | null;
    children: StructureNode[];
}

export interface Chat {
    id: string;
    project_id: string | null;
    user_id: string;
    creator_display_name?: string | null;
    project_name?: string | null;
    title: string | null;
    created_at: string;
}

export interface EditAnnotation {
    type?: "edit_data";
    kind?: "edit";
    edit_id: string;
    document_id: string;
    version_id: string;
    /** Per-document monotonic Vn for the edit's target version. */
    version_number?: number | null;
    change_id: string;
    del_w_id?: string;
    ins_w_id?: string;
    deleted_text: string;
    inserted_text: string;
    context_before?: string;
    context_after?: string;
    reason?: string;
    status: "pending" | "accepted" | "rejected";
}

export type AskInputItem = SharedAskInputItem;
export type AskInputResponseItem = SharedAskInputResponseItem;
export type AskInputsEvent = SharedAskInputsEvent;

export type AskInputsResponseEvent = {
    type: "ask_inputs_response";
    responses: AskInputResponseItem[];
};

export type AssistantEvent =
    | { type: "reasoning"; text: string; isStreaming?: boolean }
    | { type: "error"; message: string; safe_to_display?: boolean }
    | {
          type: "tool_call_start";
          name: string;
          isStreaming?: boolean;
      }
    | {
          type: "mcp_tool_call";
          connector_id: string;
          connector_name: string;
          tool_name: string;
          openai_tool_name: string;
          status: "ok" | "error";
          error?: string;
          isStreaming?: boolean;
      }
    | AskInputsEvent
    | AskInputsResponseEvent
    | { type: "thinking"; isStreaming?: boolean }
    | {
          type: "doc_read";
          filename: string;
          document_id?: string;
          version_id?: string | null;
          version_number?: number | null;
          isStreaming?: boolean;
      }
    | {
          type: "doc_find";
          filename: string;
          document_id?: string;
          version_id?: string | null;
          version_number?: number | null;
          query: string;
          total_matches: number;
          isStreaming?: boolean;
      }
    | {
          type: "doc_created";
          filename: string;
          download_url: string;
          /** Set when the generated doc is persisted as a first-class document. */
          document_id?: string;
          version_id?: string;
          version_number?: number | null;
          isStreaming?: boolean;
      }
    | { type: "doc_download"; filename: string; download_url: string }
    | {
          type: "doc_replicated";
          /** Source document filename. */
          filename: string;
          /** How many copies were produced in this single tool call. */
          count: number;
          /** One entry per new copy. Empty while streaming. */
          copies?: {
              new_filename: string;
              document_id: string;
              version_id: string;
          }[];
          error?: string;
          isStreaming?: boolean;
      }
    | { type: "workflow_applied"; workflow_id: string; title: string }
    | {
          type: "doc_edited";
          filename: string;
          document_id: string;
          version_id: string;
          /** Per-document monotonic Vn written at emit time. */
          version_number?: number | null;
          download_url: string;
          annotations: EditAnnotation[];
          error?: string;
          isStreaming?: boolean;
      }
    | {
          type: "courtlistener_search_case_law";
          query: string;
          result_count?: number;
          error?: string;
          isStreaming?: boolean;
      }
    | {
          type: "courtlistener_get_cases";
          cluster_ids: number[];
          case_count?: number;
          opinion_count?: number;
          cases?: {
              cluster_id: number;
              case_name: string | null;
              citation: string | null;
              dateFiled?: string | null;
              url?: string | null;
          }[];
          error?: string;
          isStreaming?: boolean;
      }
    | {
          type: "courtlistener_find_in_case";
          cluster_id: number | null;
          query: string;
          total_matches?: number;
          case_name?: string | null;
          citation?: string | null;
          searches?: {
              cluster_id: number | null;
              query: string;
              total_matches?: number;
              case_name?: string | null;
              citation?: string | null;
              error?: string;
          }[];
          error?: string;
          isStreaming?: boolean;
      }
    | {
          type: "courtlistener_read_case";
          cluster_id: number | null;
          case_name?: string | null;
          citation?: string | null;
          opinion_count?: number;
          error?: string;
          isStreaming?: boolean;
      }
    | {
          type: "courtlistener_verify_citations";
          citation_count?: number;
          match_count?: number;
          error?: string;
          isStreaming?: boolean;
      }
    | {
          type: "case_citation";
          cluster_id: number | null;
          case_name: string | null;
          citation: string | null;
          url: string;
          pdfUrl?: string | null;
          dateFiled?: string | null;
          document?: PanelDocument;
      }
    | {
          type: "case_opinions";
          cluster_id: number;
          document?: PanelDocument;
      }
    | { type: "content"; text: string; isStreaming?: boolean };

export type CaseCitationQuote = {
    opinionId: number | null;
    type: string | null;
    author: string | null;
    quote: string;
    verification?: QuoteVerification;
};

export interface Message {
    id?: string;
    role: "user" | "assistant";
    content: string;
    files?: MessageFile[];
    workflow?: { id: string; title: string };
    model?: string;
    citations?: Citation[];
    citationStatus?: "started" | "partial" | "final";
    events?: AssistantEvent[];
    /** Set when streaming failed; rendered as a red error block. */
    error?: string;
}

export type MessageFile = {
    filename: string;
    document_id?: string;
    version_id?: string | null;
    version_number?: number | null;
};

export interface CitationQuote {
    page?: number;
    quote: string;
}

export type QuoteVerification = {
    verified: boolean;
    source_excerpt?: string;
    start_char?: number;
    end_char?: number;
};

export type DocumentCitationQuote = {
    page: number | string;
    quote: string;
    verification?: QuoteVerification;
    /**
     * Spreadsheet citations are located by cell, not page: `sheet` is the
     * worksheet name and `cell` is an A1 address or range (e.g. "B7", "B7:C9").
     */
    sheet?: string;
    cell?: string;
};

export type DocumentCitation = {
    type: "citation_data";
    kind?: "document";
    ref: number;
    doc_id: string;
    document_id: string;
    version_id?: string | null;
    version_number?: number | null;
    filename: string;
    /** Legacy single-quote fields. Prefer `quotes` for new citations. */
    page: number | string;
    quote: string;
    sheet?: string;
    cell?: string;
    quotes?: DocumentCitationQuote[];
    /** True only when every quote was matched against the source. */
    verified?: boolean;
    document?: PanelDocument;
};

export type CaseCitation = {
    type: "citation_data";
    kind: "case";
    ref: number;
    cluster_id: number;
    case_name?: string | null;
    citation?: string | null;
    url?: string | null;
    pdfUrl?: string | null;
    dateFiled?: string | null;
    quotes: CaseCitationQuote[];
    /** True only when every quote was matched against the opinion text. */
    verified?: boolean;
    document?: PanelDocument;
};

/**
 * A citation emitted by the assistant. Document citations have doc/page
 * anchors. Case citations anchor to a CourtListener cluster and include a
 * quoted opinion passage.
 */
export type Citation = DocumentCitation | CaseCitation;

export function panelDocumentType(filename: string): PanelDocumentType {
    const extension = filename.split(".").pop()?.toLowerCase();
    if (extension === "docx" || extension === "doc") return "docx";
    if (extension === "xlsx" || extension === "xlsm" || extension === "xls") {
        return "spreadsheet";
    }
    return "pdf";
}

function legacyCaseSubdocumentId(clusterId: number, opinionId: number): string {
    return `case:${clusterId}:opinion:${opinionId}`;
}

export function panelDocumentFromCitation(
  citation: Citation,
  includeQuotes = true,
): PanelDocument {
  if (citation.document) {
    if (!includeQuotes) return { ...citation.document, quotes: [] };
    const citationQuotes =
      citation.kind === "case"
        ? citation.quotes
        : getDocumentCitationQuotes(citation);
    return {
      ...citation.document,
      quotes: citation.document.quotes.map((quote, index) => {
        const verifiedQuote = citationQuotes[index];
        return verifiedQuote
          ? {
              ...quote,
              quote: verifiedQuote.quote,
              ...(verifiedQuote.verification
                ? { verification: verifiedQuote.verification }
                : {}),
            }
          : quote;
      }),
    };
  }
    if (citation.kind === "case") {
        const title = [citation.case_name, citation.citation]
            .filter(Boolean)
            .join(", ");
        return {
            document_id: `case:${citation.cluster_id}`,
            title: title || "Case",
            type: "case",
            metadata: citation.dateFiled
                ? [{ label: "Date", value: citation.dateFiled, format: "date" }]
                : [],
            actions: [
                ...(citation.pdfUrl
                    ? [
                          {
                              type: "download" as const,
                              url: citation.pdfUrl,
                              label: "Download",
                          },
                      ]
                    : []),
                ...(citation.url
                    ? [
                          {
                              type: "link" as const,
                              url: citation.url,
                              label: "Link",
                              title: "Link",
                          },
                      ]
                    : []),
            ],
            quotes: includeQuotes
                ? citation.quotes.map((quote) => ({
                      quote: quote.quote,
                      ...(quote.verification
                          ? { verification: quote.verification }
                          : {}),
                      target: {
                          ...(typeof quote.opinionId === "number"
                              ? {
                                    subdocument_id: legacyCaseSubdocumentId(
                                        citation.cluster_id,
                                        quote.opinionId,
                                    ),
                                }
                              : {}),
                      },
                  }))
                : [],
        };
    }
    const quotes = getDocumentCitationQuotes(citation);
    return {
        document_id: citation.document_id,
        title: citation.filename,
        type: panelDocumentType(citation.filename),
        metadata: [],
        quotes: includeQuotes
            ? quotes.map((quote) => ({
                  quote: quote.quote,
                  ...(quote.verification
                      ? { verification: quote.verification }
                      : {}),
                  target: {
                      page: quote.page,
                      ...(quote.sheet ? { sheet: quote.sheet } : {}),
                      ...(quote.cell ? { cell: quote.cell } : {}),
                  },
              }))
            : [],
        version_id: citation.version_id ?? null,
        version_number: citation.version_number ?? null,
    };
}

export function panelDocumentFromCaseEvent(
    event: Extract<AssistantEvent, { type: "case_citation" }>,
): PanelDocument | null {
    if (event.document) return event.document;
    if (!event.cluster_id) return null;
    return panelDocumentFromCitation({
        type: "citation_data",
        kind: "case",
        ref: 0,
        cluster_id: event.cluster_id,
        case_name: event.case_name,
        citation: event.citation,
        url: event.url,
        pdfUrl: event.pdfUrl,
        dateFiled: event.dateFiled,
        quotes: [],
    });
}

const PAGE_BREAK_SENTINEL = "[[PAGE_BREAK]]";

export function isSpreadsheetFilename(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "xlsx" || ext === "xlsm" || ext === "xls";
}

export function isDocxFilename(filename: string): boolean {
    const ext = filename.split(".").pop()?.toLowerCase();
    return ext === "docx" || ext === "doc";
}

/**
 * Human-readable cell locator for a spreadsheet citation, e.g. "Sheet1!B7".
 * Falls back to whichever of `sheet`/`cell` is present.
 */
function formatCellLocator(sheet?: string, cell?: string): string {
    if (sheet && cell) return `${sheet}!${cell}`;
    return cell ?? sheet ?? "";
}

export function expandDocumentQuoteEntry(entry: {
    page?: number | string;
    quote: string;
}): CitationQuote[] {
    const rangeMatch =
        typeof entry.page === "string"
            ? entry.page.match(/^(\d+)\s*-\s*(\d+)$/)
            : null;
    if (rangeMatch && entry.quote.includes(PAGE_BREAK_SENTINEL)) {
        const startPage = parseInt(rangeMatch[1], 10);
        const endPage = parseInt(rangeMatch[2], 10);
        const [before, after] = entry.quote.split(PAGE_BREAK_SENTINEL);
        return [
            { page: startPage, quote: before.trim() },
            { page: endPage, quote: after.trim() },
        ].filter((e) => e.quote.length > 0);
    }
    const pageNum =
        typeof entry.page === "number"
            ? entry.page
            : parseInt(String(entry.page), 10);
    if (!Number.isFinite(pageNum)) return [];
    return [{ page: pageNum, quote: entry.quote }];
}

function getDocumentCitationQuotes(a: Citation): DocumentCitationQuote[] {
    if (a.kind === "case") return [];
    if (Array.isArray(a.quotes) && a.quotes.length) {
        return a.quotes.filter((entry) => entry.quote.trim().length > 0);
    }
    return [{ page: a.page, quote: a.quote, sheet: a.sheet, cell: a.cell }];
}

/**
 * Expand a citation into one or more (page, quote) entries suitable for
 * highlighting in the PDF viewer. A single-page citation yields one entry; a
 * cross-page citation with page "N-M" and a `[[PAGE_BREAK]]` split yields two.
 */
export function expandCitationToEntries(a: Citation): CitationQuote[] {
    if (a.kind === "case") return [];
    return getDocumentCitationQuotes(a).flatMap(expandDocumentQuoteEntry);
}

/**
 * Format the page(s) of a citation for display, e.g. "Page 3" or "Page 41-42".
 * Spreadsheets have no meaningful page locator, so this returns "" for them —
 * callers join with `.filter(Boolean)` so the locator is simply omitted.
 */
export function formatCitationPage(a: Citation): string {
    if (a.kind === "case") {
        return a.citation || a.case_name || `Case ${a.cluster_id}`;
    }
    const quotes = getDocumentCitationQuotes(a);
    // Spreadsheets are located by cell, e.g. "Sheet1!B7" (or several).
    if (isSpreadsheetFilename(a.filename)) {
        const cells = Array.from(
            new Set(
                quotes
                    .map((q) => formatCellLocator(q.sheet, q.cell))
                    .filter(Boolean),
            ),
        );
        return cells.join(", ");
    }
    const pages = Array.from(
        new Set(quotes.map((q) => String(q.page)).filter(Boolean)),
    );
    if (pages.length > 1) return `Pages ${pages.join(", ")}`;
    if (pages.length === 1) return `Page ${pages[0]}`;
    return `Page ${a.page}`;
}

/**
 * Reader-friendly version of a single raw quote: replaces [[PAGE_BREAK]] with
 * "...". Spreadsheet quotes now carry plain cell values, so no stripping.
 */
function cleanCitationQuoteText(rawQuote: string): string {
    return rawQuote.replaceAll(PAGE_BREAK_SENTINEL, "...");
}

/** Produce a reader-friendly version of the quote (replaces [[PAGE_BREAK]] with "..."). */
export function displayCitationQuote(a: Citation): string {
    if (a.kind === "case") {
        return a.quotes
            .map((q) => q.quote.replaceAll(PAGE_BREAK_SENTINEL, "..."))
            .join(" / ");
    }
    return getDocumentCitationQuotes(a)
        .map((q) => cleanCitationQuoteText(q.quote))
        .filter(Boolean)
        .join(" / ");
}

// Tabular Review

export type ColumnFormat =
    | "text"
    | "bulleted_list"
    | "number"
    | "currency"
    | "yes_no"
    | "date"
    | "tag"
    | "percentage"
    | "monetary_amount";

export interface ColumnConfig {
    index: number;
    name: string;
    prompt: string;
    format?: ColumnFormat;
    tags?: string[];
}

export interface TabularReview {
    id: string;
    project_id: string | null;
    user_id: string;
    title: string | null;
    columns_config: ColumnConfig[] | null;
    document_ids?: string[] | null;
    document_grouping?: "document" | "folder";
    workflow_id: string | null;
    practice?: string | null;
    /** Per-review email list. Used so standalone (project_id null) reviews can be shared directly. */
    shared_with?: string[];
    /** Server-set: true when the requesting user is the review's creator. */
    is_owner?: boolean;
    /** Server-set: true while another generation request holds the review lease. */
    is_running?: boolean;
    created_at: string;
    updated_at: string;
    document_count?: number;
}

export interface TabularCell {
    id: string;
    review_id: string;
    row_id: string;
    document_id: string | null;
    column_index: number;
    content: {
        summary: string;
        flag?: "green" | "grey" | "yellow" | "red";
        reasoning?: string;
    } | null;
    status: "pending" | "generating" | "done" | "error";
    created_at: string;
}

export interface TabularReviewRow {
    id: string;
    review_id: string;
    label: string;
    row_type: "document" | "folder";
    folder_id: string | null;
    library_folder_id: string | null;
    document_id: string | null;
    sort_index: number;
    source_document_ids: string[];
}

// Workflows

export interface WorkflowOpenSourceSubmission {
    id: string;
    status: "pending" | "approved" | "rejected";
    submitted_at: string;
    updated_at: string;
    reviewed_at?: string | null;
}

export interface OpenSourceWorkflowResponse extends WorkflowOpenSourceSubmission {
    mode: "created" | "updated";
}

export type OpenSourceWorkflowContributorMode = "named" | "anonymous";

export interface WorkflowContributor {
    name: string;
    organisation: string | null;
    role: string | null;
    linkedin: string | null;
}

export interface Workflow {
    id: string;
    user_id: string | null;
    metadata: {
        name?: string | null;
        title: string;
        description: string | null;
        type: "assistant" | "tabular";
        contributors: WorkflowContributor[];
        language: string;
        version: string | null;
        practice: string | null;
        jurisdictions: string[] | null;
    };
    skill_md: string | null;
    columns_config: ColumnConfig[] | null;
    is_system: boolean;
    is_default?: boolean;
    default_key?: string | null;
    created_at: string;
    shared_by_name?: string | null;
    allow_edit?: boolean;
    is_owner?: boolean;
    open_source_submission?: WorkflowOpenSourceSubmission | null;
}

export interface QuickAction {
    id: string;
    user_id: string;
    workflow_id: string;
    name: string;
    prompt: string;
    document_upload: boolean;
    surface: "app" | "word";
    enabled: boolean;
    sort_order: number;
    created_at: string;
    updated_at: string;
    workflow: { id: string; title: string };
}

export interface WorkflowReferenceDocument {
    id: string;
    workflow_id: string;
    filename: string;
    file_type: string;
    size_bytes: number | null;
    created_at: string;
    updated_at: string;
}

export interface WorkflowAddon {
    id: string;
    addon_key: string;
    pack_key: string | null;
    pack_title: string | null;
    pack_description: string | null;
    pack_version: string | null;
    version: string | null;
    title: string;
    description: string | null;
    type: "assistant" | "tabular";
    prompt_md?: string | null;
    columns_config?: ColumnConfig[] | null;
    contributors: WorkflowContributor[];
    language: string;
    practice: string | null;
    jurisdictions: string[] | null;
    active: boolean;
    updated_at: string;
    reference_files?: {
        id: string;
        filename: string;
        file_type: string;
        size_bytes: number | null;
        created_at: string;
    }[];
}

// API helpers

export interface ChatDetailOut {
    chat: Chat;
    messages: Message[];
}

export interface TabularReviewDetailOut {
    review: TabularReview;
    cells: TabularCell[];
    rows: TabularReviewRow[];
    documents: Document[];
}
