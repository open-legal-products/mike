"use client";

import type { AssistantEvent, Citation } from "@/app/components/shared/types";
import { isPanelDocument } from "@/app/components/shared/types";

/**
 * One assistant turn's event stream, as a standalone object.
 *
 * This used to live inside `useAssistantChat` as a `useRef` plus a dozen
 * closures that all wrote to "the last assistant message". That was correct
 * while exactly one stream could ever be open. Assigned agents break that
 * assumption: the parent chat's stream and up to six agent streams run at the
 * same time, in different parts of the tree, each appending to its own
 * message.
 *
 * The fix is not a global registry — it is making the per-stream state an
 * ordinary value that each caller owns one of. A buffer knows nothing about
 * React, messages, or which chat it belongs to; it accumulates events and
 * calls `onChange` with an immutable snapshot. Whoever created it decides
 * where that snapshot lands.
 */
export class AssistantEventBuffer {
    private events: AssistantEvent[];

    constructor(
        private readonly onChange: (events: AssistantEvent[]) => void,
        initial: readonly AssistantEvent[] = [],
    ) {
        this.events = [...initial];
    }

    /** Current events. Treat as read-only; mutate through the methods. */
    snapshot(): AssistantEvent[] {
        return [...this.events];
    }

    /** Replace the buffer wholesale, without notifying — used at turn start. */
    reset(events: readonly AssistantEvent[] = []): void {
        this.events = [...events];
    }

    private commit(next: AssistantEvent[]): void {
        this.events = next;
        this.onChange([...next]);
    }

    /**
     * Finalize any in-flight streaming content event so the next
     * content_delta starts a fresh block. Called before any non-content event
     * is appended, so interleaved content / reasoning / tool events stay in
     * chronological order — without the later content block inheriting the
     * earlier block's accumulated text.
     */
    finalizeContent(): void {
        const last = this.events[this.events.length - 1];
        if (last?.type !== "content" || !last.isStreaming) return;
        this.commit([
            ...this.events.slice(0, -1),
            { type: "content", text: last.text },
        ]);
    }

    /**
     * If the model transitions from reasoning into content/tool without a
     * reasoning_block_end (or the events arrive out of order), the prior
     * reasoning event would otherwise stay flagged isStreaming forever.
     */
    finalizeReasoning(): void {
        const last = this.events[this.events.length - 1];
        if (last?.type !== "reasoning" || !last.isStreaming) return;
        this.commit([
            ...this.events.slice(0, -1),
            { type: "reasoning", text: last.text },
        ]);
    }

    /** Drop transient placeholders once a real event is about to land. */
    clearPlaceholders(): void {
        const after = this.events.filter((e) => !isStreamingPlaceholder(e));
        if (after.length === this.events.length) return;
        this.commit(after);
    }

    /**
     * Transient placeholder events (tool_call_start, thinking) fill the
     * latency gap between real SSE events so the wrapper doesn't look stuck.
     */
    pushThinking(): void {
        const last = this.events[this.events.length - 1];
        // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
        if (last && isStreamingPlaceholder(last)) return;
        this.commit([...this.events, { type: "thinking", isStreaming: true }]);
    }

    push(event: AssistantEvent): void {
        this.finalizeContent();
        this.finalizeReasoning();
        // A real event, or a more specific placeholder such as
        // tool_call_start, should replace any generic "Thinking..." line.
        this.commit([
            ...this.events.filter((e) => !isStreamingPlaceholder(e)),
            event,
        ]);
    }

    /** Append raw text without touching placeholders — internal to error handling. */
    append(event: AssistantEvent): void {
        this.commit([...this.events, event]);
    }

    updateMatching(
        predicate: (e: AssistantEvent) => boolean,
        updater: (e: AssistantEvent) => AssistantEvent,
    ): boolean {
        const index = [...this.events]
            .map((_, i) => i)
            .reverse()
            .find((i) => predicate(this.events[i]));
        if (index === undefined) return false;
        const next = [...this.events];
        next[index] = updater(this.events[index]);
        this.commit(next);
        return true;
    }

    appendContentDelta(text: string): void {
        // Real content is streaming — retire any "Thinking…" / "Running…"
        // placeholders, and finalize any in-flight reasoning block so it
        // doesn't get stuck rendering as streaming.
        this.clearPlaceholders();
        this.finalizeReasoning();

        const last = this.events[this.events.length - 1];
        if (last?.type !== "content" || !last.isStreaming) {
            // Start a fresh block so interleaved tool/reasoning events split
            // content naturally.
            this.commit([
                ...this.events,
                { type: "content", text, isStreaming: true },
            ]);
            return;
        }
        const next = [...this.events];
        next[next.length - 1] = {
            type: "content",
            text: `${last.text}${text}`,
            isStreaming: true,
        };
        this.commit(next);
    }

    appendReasoningDelta(text: string): void {
        const last = this.events[this.events.length - 1];
        if (last?.type === "reasoning" && last.isStreaming) {
            this.commit([
                ...this.events.slice(0, -1),
                { type: "reasoning", text: last.text + text, isStreaming: true },
            ]);
            return;
        }
        // New reasoning block — finalize any in-flight content event first so
        // the next content_delta starts a fresh block at the correct position.
        this.finalizeContent();
        this.clearPlaceholders();
        this.commit([
            ...this.events,
            { type: "reasoning", text, isStreaming: true },
        ]);
    }

    endReasoningBlock(): void {
        const last = this.events[this.events.length - 1];
        if (last?.type === "reasoning" && last.isStreaming) {
            this.commit([
                ...this.events.slice(0, -1),
                { type: "reasoning", text: last.text },
            ]);
        } else {
            this.onChange(this.snapshot());
        }
        this.pushThinking();
    }

    /** Strip placeholders and streaming flags — the shape a cancelled turn keeps. */
    settle(): AssistantEvent[] {
        const next = cancelStreamingEvents(this.events);
        this.commit(next);
        return [...next];
    }
}

/** Transient events that exist only to show the turn is still alive. */
export function isStreamingPlaceholder(event: AssistantEvent): boolean {
    return (
        (event.type === "tool_call_start" || event.type === "thinking") &&
        !!event.isStreaming
    );
}

export function cancelStreamingEvents(
    events: readonly AssistantEvent[],
): AssistantEvent[] {
    return events
        .filter((event) => !isStreamingPlaceholder(event))
        .map((event) => {
            if (!("isStreaming" in event) || !event.isStreaming) return event;
            const rest = { ...event };
            delete (rest as { isStreaming?: boolean }).isStreaming;
            return rest as AssistantEvent;
        });
}

export function appendCancellationEvent(
    events: readonly AssistantEvent[],
): AssistantEvent[] {
    return [
        ...cancelStreamingEvents(events),
        { type: "content" as const, text: "Cancelled by user." },
    ];
}

export function readableStreamError(
    value: unknown,
    safeToDisplay: boolean,
): string {
    if (safeToDisplay && typeof value === "string" && value.trim()) {
        return value.trim();
    }
    return "Sorry, something went wrong.";
}

function parseCourtlistenerEventCases(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation: typeof row.citation === "string" ? row.citation : null,
                dateFiled:
                    typeof row.dateFiled === "string" ? row.dateFiled : null,
                url: typeof row.url === "string" ? row.url : null,
            };
        })
        .filter(
            (item): item is NonNullable<typeof item> =>
                !!item && item.cluster_id > 0,
        );
}

function parseCourtlistenerCaseSearches(value: unknown) {
    if (!Array.isArray(value)) return undefined;
    return value
        .map((item) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
                return null;
            }
            const row = item as Record<string, unknown>;
            return {
                cluster_id:
                    typeof row.cluster_id === "number" ? row.cluster_id : null,
                query: typeof row.query === "string" ? row.query : "",
                total_matches:
                    typeof row.total_matches === "number"
                        ? row.total_matches
                        : 0,
                case_name:
                    typeof row.case_name === "string" ? row.case_name : null,
                citation: typeof row.citation === "string" ? row.citation : null,
                error: typeof row.error === "string" ? row.error : undefined,
            };
        })
        .filter((item): item is NonNullable<typeof item> => !!item);
}

function parseAskInputsItems(
    value: unknown,
): Extract<AssistantEvent, { type: "ask_inputs" }>["items"] {
    const rawItems = Array.isArray(value) ? (value as unknown[]) : [];
    return rawItems.reduce<
        Extract<AssistantEvent, { type: "ask_inputs" }>["items"]
    >((acc, item, index) => {
        if (!item || typeof item !== "object") return acc;
        const row = item as Record<string, unknown>;
        const id =
            typeof row.id === "string" && row.id.trim()
                ? row.id.trim()
                : `input-${index + 1}`;
        const responsePrefix =
            typeof row.response_prefix === "string"
                ? row.response_prefix
                : undefined;
        if (row.kind === "choice") {
            const options = Array.isArray(row.options)
                ? (row.options as unknown[]).flatMap((option) => {
                      if (!option || typeof option !== "object") return [];
                      const optionRow = option as Record<string, unknown>;
                      const optionValue =
                          typeof optionRow.value === "string"
                              ? optionRow.value
                              : typeof optionRow.label === "string"
                                ? optionRow.label
                                : "";
                      if (!optionValue.trim()) return [];
                      return [{ value: optionValue }];
                  })
                : [];
            acc.push({
                id,
                kind: "choice",
                question:
                    typeof row.question === "string"
                        ? row.question
                        : "Please choose an option.",
                options,
                allow_other: row.allow_other !== false,
                other_label:
                    typeof row.other_label === "string"
                        ? row.other_label
                        : "Other",
                response_prefix: responsePrefix,
            });
            return acc;
        }
        if (row.kind === "text") {
            acc.push({
                id,
                kind: "text",
                question:
                    typeof row.question === "string"
                        ? row.question
                        : "Please provide the requested information.",
                response_prefix: responsePrefix,
            });
            return acc;
        }
        if (row.kind === "documents") {
            const documentTypes = Array.isArray(row.document_types)
                ? (row.document_types as unknown[])
                      .filter((type): type is string => typeof type === "string")
                      .map((type) => type.trim())
                      .filter(Boolean)
                : [];
            acc.push({
                id,
                kind: "documents",
                document_types: documentTypes,
                response_prefix: responsePrefix,
            });
        }
        return acc;
    }, []);
}

/**
 * Everything a stream does that is *not* buffer manipulation. Each surface
 * supplies its own: the parent chat updates the sidebar and the URL, an agent
 * updates a dock card and nothing else.
 */
export interface AssistantStreamHandlers {
    onChatId?: (chatId: string, assistantMessageId?: string) => void;
    onChatTitle?: (chatId: string, title: string) => void;
    onContentDone?: () => void;
    onError?: (message: string, safeToDisplay: boolean) => void;
    onCitations?: (
        citations: Citation[],
        status: "started" | "partial" | "final",
    ) => void;
}

/**
 * Fold one parsed SSE frame into the buffer.
 *
 * Every branch that only reshapes events lives here; anything that touches the
 * surrounding application goes out through `handlers`. That split is what lets
 * an agent's side-panel thread render doc reads, reasoning and tool activity
 * exactly like the main transcript without inheriting the main transcript's
 * navigation side effects.
 */
export function applyAssistantStreamFrame(
    data: Record<string, unknown>,
    buffer: AssistantEventBuffer,
    handlers: AssistantStreamHandlers = {},
): void {
    const type = data.type;

    if (type === "chat_id") {
        if (typeof data.chatId === "string") {
            handlers.onChatId?.(
                data.chatId,
                typeof data.assistantMessageId === "string"
                    ? data.assistantMessageId
                    : undefined,
            );
        }
        return;
    }

    if (
        type === "chat_title" &&
        typeof data.chatId === "string" &&
        typeof data.title === "string"
    ) {
        handlers.onChatTitle?.(data.chatId, data.title);
        return;
    }

    if (type === "content_done") {
        handlers.onContentDone?.();
        return;
    }

    if (type === "error") {
        const safeToDisplay = data.safe_to_display === true;
        const message = readableStreamError(data.message, safeToDisplay);
        buffer.clearPlaceholders();
        buffer.finalizeContent();
        buffer.finalizeReasoning();
        buffer.append({
            type: "error",
            message,
            ...(safeToDisplay ? { safe_to_display: true } : {}),
        });
        handlers.onError?.(message, safeToDisplay);
        return;
    }

    if (type === "content_delta") {
        buffer.appendContentDelta(data.text as string);
        return;
    }

    if (type === "reasoning_delta") {
        buffer.appendReasoningDelta(data.text as string);
        return;
    }

    if (type === "reasoning_block_end") {
        buffer.endReasoningBlock();
        return;
    }

    if (type === "tool_call_start") {
        // Transient placeholder so the client immediately shows activity after
        // the model ends a turn with tool_use. Replaced by the real tool event
        // if one arrives; otherwise it lingers as a "Working…" indicator.
        buffer.push({
            type: "tool_call_start",
            name: (data.name as string) ?? "",
            isStreaming: true,
        });
        return;
    }

    if (type === "workflow_applied") {
        buffer.push({
            type: "workflow_applied",
            workflow_id: data.workflow_id as string,
            title: data.title as string,
        });
        return;
    }

    if (type === "edit_proposal") {
        buffer.push({
            type: "edit_proposal",
            proposal_id: (data.proposal_id as string) ?? "",
            target_excerpt: (data.target_excerpt as string) ?? "",
            replacement:
                typeof data.replacement === "string" ? data.replacement : "",
            reason: typeof data.reason === "string" ? data.reason : null,
            status: "pending",
        });
        return;
    }

    if (type === "case_citation") {
        buffer.push({
            type: "case_citation",
            cluster_id:
                typeof data.cluster_id === "number" ? data.cluster_id : null,
            case_name:
                typeof data.case_name === "string" ? data.case_name : null,
            citation: typeof data.citation === "string" ? data.citation : null,
            url: data.url as string,
            pdfUrl: typeof data.pdfUrl === "string" ? data.pdfUrl : null,
            dateFiled:
                typeof data.dateFiled === "string" ? data.dateFiled : null,
            document: isPanelDocument(data.document) ? data.document : undefined,
        });
        return;
    }

    if (type === "case_opinions") {
        buffer.push({
            type: "case_opinions",
            cluster_id: typeof data.cluster_id === "number" ? data.cluster_id : 0,
            document: isPanelDocument(data.document) ? data.document : undefined,
        });
        return;
    }

    if (type === "mcp_tool_start") {
        buffer.push({
            type: "mcp_tool_call",
            connector_id: "",
            connector_name: "",
            tool_name: (data.name as string) ?? "",
            openai_tool_name: (data.name as string) ?? "",
            status: "ok",
            isStreaming: true,
        });
        return;
    }

    if (type === "mcp_tool_result") {
        const openaiToolName = (data.name as string) ?? "";
        buffer.updateMatching(
            (e) =>
                e.type === "mcp_tool_call" &&
                e.openai_tool_name === openaiToolName &&
                !!e.isStreaming,
            () => ({
                type: "mcp_tool_call",
                connector_id: "",
                connector_name:
                    typeof data.connector_name === "string"
                        ? data.connector_name
                        : "",
                tool_name:
                    typeof data.tool_name === "string"
                        ? data.tool_name
                        : openaiToolName,
                openai_tool_name: openaiToolName,
                status: data.status === "error" ? "error" : "ok",
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "courtlistener_search_case_law_start") {
        buffer.push({
            type: "courtlistener_search_case_law",
            query: (data.query as string) ?? "",
            isStreaming: true,
        });
        return;
    }

    if (type === "courtlistener_search_case_law") {
        buffer.updateMatching(
            (e) =>
                e.type === "courtlistener_search_case_law" &&
                e.query === (data.query as string) &&
                !!e.isStreaming,
            () => ({
                type: "courtlistener_search_case_law",
                query: (data.query as string) ?? "",
                result_count:
                    typeof data.result_count === "number"
                        ? data.result_count
                        : 0,
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "courtlistener_get_cases_start") {
        buffer.push({
            type: "courtlistener_get_cases",
            cluster_ids: Array.isArray(data.cluster_ids)
                ? (data.cluster_ids as unknown[]).filter(
                      (value): value is number => typeof value === "number",
                  )
                : [],
            isStreaming: true,
        });
        return;
    }

    if (type === "courtlistener_get_cases") {
        buffer.updateMatching(
            (e) => e.type === "courtlistener_get_cases" && !!e.isStreaming,
            () => ({
                type: "courtlistener_get_cases",
                cluster_ids: Array.isArray(data.cluster_ids)
                    ? (data.cluster_ids as unknown[]).filter(
                          (value): value is number => typeof value === "number",
                      )
                    : [],
                case_count:
                    typeof data.case_count === "number" ? data.case_count : 0,
                opinion_count:
                    typeof data.opinion_count === "number"
                        ? data.opinion_count
                        : 0,
                cases: parseCourtlistenerEventCases(data.cases),
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "courtlistener_find_in_case_start") {
        const searches = parseCourtlistenerCaseSearches(data.searches);
        buffer.push({
            type: "courtlistener_find_in_case",
            cluster_id: searches?.length
                ? null
                : typeof data.cluster_id === "number"
                  ? data.cluster_id
                  : null,
            query: searches?.length ? "" : ((data.query as string) ?? ""),
            searches,
            isStreaming: true,
        });
        return;
    }

    if (type === "courtlistener_find_in_case") {
        const searches = parseCourtlistenerCaseSearches(data.searches);
        buffer.updateMatching(
            (e) =>
                e.type === "courtlistener_find_in_case" &&
                (searches?.length
                    ? Array.isArray(e.searches)
                    : e.cluster_id ===
                          (typeof data.cluster_id === "number"
                              ? data.cluster_id
                              : null) && e.query === (data.query as string)) &&
                !!e.isStreaming,
            () => ({
                type: "courtlistener_find_in_case",
                cluster_id: searches?.length
                    ? null
                    : typeof data.cluster_id === "number"
                      ? data.cluster_id
                      : null,
                query: searches?.length ? "" : ((data.query as string) ?? ""),
                total_matches:
                    typeof data.total_matches === "number"
                        ? data.total_matches
                        : 0,
                searches,
                case_name:
                    typeof data.case_name === "string" ? data.case_name : null,
                citation:
                    typeof data.citation === "string" ? data.citation : null,
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "courtlistener_read_case_start") {
        buffer.push({
            type: "courtlistener_read_case",
            cluster_id:
                typeof data.cluster_id === "number" ? data.cluster_id : null,
            isStreaming: true,
        });
        return;
    }

    if (type === "courtlistener_read_case") {
        buffer.updateMatching(
            (e) =>
                e.type === "courtlistener_read_case" &&
                e.cluster_id ===
                    (typeof data.cluster_id === "number"
                        ? data.cluster_id
                        : null) &&
                !!e.isStreaming,
            () => ({
                type: "courtlistener_read_case",
                cluster_id:
                    typeof data.cluster_id === "number" ? data.cluster_id : null,
                case_name:
                    typeof data.case_name === "string" ? data.case_name : null,
                citation:
                    typeof data.citation === "string" ? data.citation : null,
                opinion_count:
                    typeof data.opinion_count === "number"
                        ? data.opinion_count
                        : 0,
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "courtlistener_verify_citations_start") {
        buffer.push({
            type: "courtlistener_verify_citations",
            citation_count:
                typeof data.citation_count === "number"
                    ? data.citation_count
                    : 0,
            isStreaming: true,
        });
        return;
    }

    if (type === "courtlistener_verify_citations") {
        buffer.updateMatching(
            (e) =>
                e.type === "courtlistener_verify_citations" && !!e.isStreaming,
            () => ({
                type: "courtlistener_verify_citations",
                citation_count:
                    typeof data.citation_count === "number"
                        ? data.citation_count
                        : 0,
                match_count:
                    typeof data.match_count === "number" ? data.match_count : 0,
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "doc_read_start") {
        buffer.push({
            type: "doc_read",
            filename: data.filename as string,
            document_id:
                typeof data.document_id === "string"
                    ? data.document_id
                    : undefined,
            version_id:
                typeof data.version_id === "string" ? data.version_id : null,
            version_number:
                typeof data.version_number === "number"
                    ? data.version_number
                    : null,
            isStreaming: true,
        });
        return;
    }

    if (type === "ask_inputs") {
        const items = parseAskInputsItems(data.items);
        if (items.length > 0) buffer.push({ type: "ask_inputs", items });
        return;
    }

    if (type === "doc_read") {
        buffer.updateMatching(
            (e) =>
                e.type === "doc_read" &&
                e.filename === data.filename &&
                !!e.isStreaming,
            (e) => {
                const event = e as Extract<AssistantEvent, { type: "doc_read" }>;
                return {
                    ...event,
                    document_id:
                        typeof data.document_id === "string"
                            ? data.document_id
                            : event.document_id,
                    version_id:
                        typeof data.version_id === "string"
                            ? data.version_id
                            : event.version_id,
                    version_number:
                        typeof data.version_number === "number"
                            ? data.version_number
                            : event.version_number,
                    isStreaming: false,
                };
            },
        );
        buffer.pushThinking();
        return;
    }

    if (type === "doc_find_start") {
        buffer.push({
            type: "doc_find",
            filename: data.filename as string,
            document_id:
                typeof data.document_id === "string"
                    ? data.document_id
                    : undefined,
            version_id:
                typeof data.version_id === "string" ? data.version_id : null,
            version_number:
                typeof data.version_number === "number"
                    ? data.version_number
                    : null,
            query: (data.query as string) ?? "",
            total_matches: 0,
            isStreaming: true,
        });
        return;
    }

    if (type === "doc_find") {
        buffer.updateMatching(
            (e) =>
                e.type === "doc_find" &&
                e.filename === data.filename &&
                e.query === (data.query as string) &&
                !!e.isStreaming,
            (e) => {
                const event = e as Extract<AssistantEvent, { type: "doc_find" }>;
                return {
                    ...event,
                    document_id:
                        typeof data.document_id === "string"
                            ? data.document_id
                            : event.document_id,
                    version_id:
                        typeof data.version_id === "string"
                            ? data.version_id
                            : event.version_id,
                    version_number:
                        typeof data.version_number === "number"
                            ? data.version_number
                            : event.version_number,
                    isStreaming: false,
                    total_matches:
                        typeof data.total_matches === "number"
                            ? data.total_matches
                            : event.total_matches,
                };
            },
        );
        buffer.pushThinking();
        return;
    }

    if (type === "doc_created_start") {
        buffer.push({
            type: "doc_created",
            filename: data.filename as string,
            download_url: "",
            isStreaming: true,
        });
        return;
    }

    if (type === "doc_download") {
        buffer.push({
            type: "doc_download",
            filename: data.filename as string,
            download_url: data.download_url as string,
        });
        return;
    }

    if (type === "doc_created") {
        buffer.updateMatching(
            (e) =>
                e.type === "doc_created" &&
                e.filename === data.filename &&
                !!e.isStreaming,
            (e) => {
                const next: Extract<AssistantEvent, { type: "doc_created" }> = {
                    type: "doc_created",
                    filename: (e as { filename: string }).filename,
                    download_url: data.download_url as string,
                    isStreaming: false,
                };
                if (typeof data.document_id === "string") {
                    next.document_id = data.document_id;
                }
                if (typeof data.version_id === "string") {
                    next.version_id = data.version_id;
                }
                if (typeof data.version_number === "number") {
                    next.version_number = data.version_number;
                }
                return next;
            },
        );
        buffer.pushThinking();
        return;
    }

    if (type === "doc_replicate_start") {
        buffer.push({
            type: "doc_replicated",
            filename: data.filename as string,
            count: typeof data.count === "number" ? data.count : 1,
            isStreaming: true,
        });
        return;
    }

    if (type === "doc_replicated") {
        buffer.updateMatching(
            (e) =>
                e.type === "doc_replicated" &&
                e.filename === data.filename &&
                !!e.isStreaming,
            () => ({
                type: "doc_replicated",
                filename: data.filename as string,
                count:
                    typeof data.count === "number"
                        ? data.count
                        : Array.isArray(data.copies)
                          ? (data.copies as unknown[]).length
                          : 1,
                copies: Array.isArray(data.copies)
                    ? (data.copies as {
                          new_filename: string;
                          document_id: string;
                          version_id: string;
                      }[])
                    : undefined,
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "doc_edited_start") {
        buffer.push({
            type: "doc_edited",
            filename: data.filename as string,
            document_id: "",
            version_id: "",
            download_url: "",
            annotations: [],
            isStreaming: true,
        });
        return;
    }

    if (type === "doc_edited") {
        buffer.updateMatching(
            (e) =>
                e.type === "doc_edited" &&
                e.filename === data.filename &&
                !!e.isStreaming,
            () => ({
                type: "doc_edited",
                filename: data.filename as string,
                document_id: (data.document_id as string) ?? "",
                version_id: (data.version_id as string) ?? "",
                version_number:
                    typeof data.version_number === "number"
                        ? data.version_number
                        : null,
                download_url: (data.download_url as string) ?? "",
                annotations: Array.isArray(data.annotations)
                    ? (data.annotations as import("@/app/components/shared/types").EditAnnotation[])
                    : [],
                error: typeof data.error === "string" ? data.error : undefined,
                isStreaming: false,
            }),
        );
        buffer.pushThinking();
        return;
    }

    if (type === "citations") {
        const status =
            data.status === "started" ||
            data.status === "partial" ||
            data.status === "final"
                ? data.status
                : "final";
        const incoming = (data.citations ?? []) as Citation[];
        if (status === "final") {
            // End-of-stream signal — scrub any lingering placeholders so they
            // don't persist into the finalised message. Finalize content first
            // so adding citations cannot re-render the markdown/citation view
            // against a streaming block.
            buffer.finalizeContent();
            buffer.clearPlaceholders();
        }
        handlers.onCitations?.(incoming, status);
    }
}

/**
 * Read an SSE response to completion, handing each parsed frame to `onFrame`.
 *
 * Line-oriented rather than record-oriented, and tolerant of a response that
 * ends without a trailing newline: the decoder is flushed on `done` and the
 * remaining buffer parsed as the last record. A frame that fails to parse is
 * logged and skipped rather than ending the stream.
 */
export async function consumeAssistantSseStream(
    response: Response,
    onFrame: (data: Record<string, unknown>) => void,
): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    for (;;) {
        const { done, value } = await reader.read();
        buffer += done
            ? decoder.decode()
            : decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = done ? "" : lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === "[DONE]") continue;
            try {
                onFrame(JSON.parse(dataStr) as Record<string, unknown>);
            } catch (e) {
                console.warn(
                    "[assistantStream] failed to parse SSE line:",
                    trimmed,
                    e,
                );
            }
        }

        if (done) break;
    }
}
