"use client";

import { useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import type {
    AssistantEvent,
    Citation,
    EditAnnotation,
    PanelDocument,
} from "../shared/types";
import { EditCard } from "./EditCard";
import { PreResponseWrapper } from "./PreResponseWrapper";
import { ResponseStatus, type StatusState } from "./message/ResponseStatus";
import { eventErrorMessage, toolCallLabel } from "./message/eventUtils";
import { preprocessCitations, internalCaseHref } from "./message/citationUtils";
import { useSmoothedReveal } from "./message/useSmoothedReveal";
import { MarkdownContent } from "./message/MarkdownContent";
import { CitationsBlock, buildCitationAppendix } from "./message/CitationSources";
import { EditCardsSection } from "./message/EditCardsSection";
import {
    AskInputsBlock,
    CourtListenerBlock,
    DocCreatedBlock,
    DocDownloadBlock,
    DocEditBlock,
    DocFindBlock,
    DocReadBlock,
    DocReplicatedBlock,
    EventBlock,
    ReasoningBlock,
    WorkflowAppliedBlock,
    type CourtListenerBlockItem,
} from "./message/EventBlocks";

interface Props {
    events?: AssistantEvent[];
    isStreaming?: boolean;
    isError?: boolean;
    /** Human-readable error text rendered alongside the red Mike icon. */
    errorMessage?: string;
    citations?: Citation[];
    citationStatus?: "started" | "partial" | "final";
    activeCitation?: Citation | null;
    onCitationClick?: (citation: Citation) => void;
    onOpenCitationSource?: (citation: Citation) => void;
    onCaseClick?: (
        citation: Extract<AssistantEvent, { type: "case_citation" }>,
    ) => void;
    minHeight?: string;
    onWorkflowClick?: (workflowId: string) => void;
    onEditViewClick?: (
        ann: EditAnnotation,
        filename: string,
        changeNumber?: number,
    ) => void;
    /**
     * Opens the editor panel for a document without auto-highlighting any
     * specific edit. Used by the download card click — opening a doc to
     * read/download shouldn't jump the viewer to the first edit.
     */
    onOpenDocument?: (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => void;
    /**
     * Fires immediately when the user clicks Accept / Reject (single card
     * or the bulk "Accept all" / "Reject all"), before the backend call.
     * Parents use this to flip download cards / editor viewers into a
     * "saving" state for the duration of the round-trip.
     */
    onEditResolveStart?: (args: {
        editId: string;
        documentId: string;
        verb: "accept" | "reject";
    }) => void;
    onEditResolved?: (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => void;
    onEditError?: (args: {
        editId: string;
        documentId: string;
        versionId: string | null;
        message: string;
    }) => void;
    isDocReloading?: (documentId: string) => boolean;
    /**
     * True while an accept/reject request for this specific edit is in
     * flight. Used to disable just that edit's Accept/Reject controls
     * (sibling edits on the same doc stay clickable).
     */
    isEditReloading?: (editId: string) => boolean;
    /**
     * External override for individual edit statuses. When present, an
     * EditCard looks up its edit_id here and treats the mapped value
     * ("accepted" / "rejected") as authoritative — used so bulk-resolved
     * edits flip their per-card UI without per-card clicks.
     */
    resolvedEditStatuses?: Record<string, "accepted" | "rejected">;
}

export function AssistantMessage({
    events,
    isStreaming = false,
    isError = false,
    errorMessage,
    citations = [],
    citationStatus,
    activeCitation,
    onCitationClick,
    onOpenCitationSource,
    onCaseClick,
    minHeight = "0px",
    onWorkflowClick,
    onEditViewClick,
    onOpenDocument,
    onEditResolveStart,
    onEditResolved,
    onEditError,
    isDocReloading,
    isEditReloading,
    resolvedEditStatuses,
}: Props) {
    const contentDivRef = useRef<HTMLDivElement | null>(null);
    const [isCopied, setIsCopied] = useState(false);
    // Per-document override of the download URL, set as Accept/Reject resolves
    // each tracked change and produces a new version.
    const [resolvedOverrides, setResolvedOverrides] = useState<
        Record<string, string>
    >({});

    const handleEditResolved = (args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        if (args.downloadUrl) {
            setResolvedOverrides((prev) => ({
                ...prev,
                [args.documentId]: args.downloadUrl as string,
            }));
        }
        onEditResolved?.(args);
    };

    const eventErrorMessages = (events ?? [])
        .map(eventErrorMessage)
        .filter((message): message is string => !!message);
    const topLevelErrorMessage =
        errorMessage ??
        (
            (events ?? []).find((event) => event.type === "error") as
                | Extract<AssistantEvent, { type: "error" }>
                | undefined
        )?.message ??
        null;
    const effectiveErrorMessage =
        topLevelErrorMessage ?? eventErrorMessages[0] ?? null;
    const hasError = isError || !!effectiveErrorMessage;
    const status: StatusState = hasError
        ? "error"
        : isStreaming
          ? "active"
          : null;

    const isRenderableEvent = (event: AssistantEvent) =>
        event.type !== "error" &&
        event.type !== "ask_inputs_response" &&
        event.type !== "case_citation" &&
        event.type !== "case_opinions" &&
        // Agent proposals render as their own accept/reject cards below the
        // message, the way document edits do, so they must not count as an
        // inline block — otherwise the block chain draws a connector to
        // nothing.
        event.type !== "edit_proposal";

    // Find the last content event so its raw text can be smoothed before
    // citation preprocessing — slicing already-preprocessed text would risk
    // chopping a `§N§` citation token in half.
    const lastContentIdx = events
        ? events.reduce(
              (last, e, idx) => (e.type === "content" ? idx : last),
              -1,
          )
        : -1;
    const lastContentEvent =
        events && lastContentIdx >= 0
            ? (events[lastContentIdx] as Extract<
                  AssistantEvent,
                  { type: "content" }
              >)
            : null;
    // Only smooth while the content event is still the visible tail. The
    // moment the model emits a follow-up (tool call, reasoning, another
    // content block), that content's text is frozen on the server — keeping
    // it half-revealed below would make a tool-call wrapper appear under
    // prose that still looks like it's typing.
    const lastRenderableIdx = events
        ? events.reduce(
              (last, e, idx) => (isRenderableEvent(e) ? idx : last),
              -1,
          )
        : -1;
    const contentIsTail =
        lastContentEvent !== null && lastContentIdx === lastRenderableIdx;
    const smoothedLastText = useSmoothedReveal(
        lastContentEvent?.text ?? "",
        isStreaming && contentIsTail,
    );

    // Pre-process citations for all content events. Each [N] marker resolves
    // to exactly one citation (models are instructed to use shared refs
    // only for cross-page continuations via the [[PAGE_BREAK]] sentinel).
    const inlineCitationTargets: Citation[] = [];
    const caseCitations = new Map<
        string,
        Extract<AssistantEvent, { type: "case_citation" }>
    >();
    const caseDocuments = new Map<number, PanelDocument>();
    const processedTexts: string[] = [];
    if (events) {
        for (let i = 0; i < events.length; i++) {
            const event = events[i];
            if (event.type === "case_citation") {
                const hrefKey = internalCaseHref(event.cluster_id);
                if (hrefKey) caseCitations.set(hrefKey, event);
            } else if (event.type === "case_opinions") {
                if (event.document) {
                    caseDocuments.set(event.cluster_id, event.document);
                }
            }
            processedTexts.push(
                event.type === "content"
                    ? preprocessCitations(
                          i === lastContentIdx ? smoothedLastText : event.text,
                          citations,
                          inlineCitationTargets,
                      )
                    : "",
            );
        }
    }
    const handleOpenCitationSource = (citation: Citation) => {
        if (onOpenCitationSource) {
            onOpenCitationSource(citation);
            return;
        }
        if (citation.kind === "case" || !onOpenDocument) return;
        onOpenDocument({
            documentId: citation.document_id,
            filename: citation.filename,
            versionId: citation.version_id ?? null,
            versionNumber: citation.version_number ?? null,
        });
    };
    const canOpenCitationSource = (citation: Citation) =>
        !!onOpenCitationSource ||
        (citation.kind !== "case" && !!onOpenDocument);
    const showCitationBlock =
        !!citationStatus || (!isStreaming && citations.length > 0);
    const handleCopy = async () => {
        try {
            let html = "";
            let plainText = "";
            if (contentDivRef.current) {
                const clone = contentDivRef.current.cloneNode(
                    true,
                ) as HTMLElement;
                clone.querySelectorAll("[data-citation-ref]").forEach((el) => {
                    const ref = el.getAttribute("data-citation-ref");
                    if (!ref) return;
                    const sup = document.createElement("sup");
                    sup.textContent = ref;
                    el.replaceWith(sup);
                });
                html = clone.innerHTML;
                plainText = clone.textContent || "";
            }
            const appendix = buildCitationAppendix(citations);
            html += appendix.html;
            plainText += appendix.text;
            const item = new ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([plainText], { type: "text/plain" }),
            });
            await navigator.clipboard.write([item]);
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
        } catch {
            // ignore
        }
    };

    // Walk events in chronological order and group consecutive non-content
    // events into their own PreResponseWrapper. Content events render
    // between wrappers, so reasoning/tool chatter that arrives after the
    // model has already streamed some prose gets its own wrapper.
    type EventGroup =
        | { kind: "pre"; events: AssistantEvent[]; indices: number[] }
        | {
              kind: "content";
              event: Extract<AssistantEvent, { type: "content" }>;
              index: number;
          };

    const groups: EventGroup[] = [];
    if (events) {
        let current: Extract<EventGroup, { kind: "pre" }> | null = null;
        events.forEach((e, i) => {
            if (!isRenderableEvent(e)) return;
            if (e.type === "content") {
                if (current) {
                    groups.push(current);
                    current = null;
                }
                groups.push({ kind: "content", event: e, index: i });
            } else {
                if (!current)
                    current = { kind: "pre", events: [], indices: [] };
                current.events.push(e);
                current.indices.push(i);
            }
        });
        if (current) groups.push(current);
    }

    const hasContentAfter = (groupIdx: number): boolean => {
        for (let i = groupIdx + 1; i < groups.length; i++) {
            const g = groups[i];
            if (g.kind === "content" && g.event.text.length > 0) return true;
        }
        return false;
    };

    const askInputsResponseFor = (askInputsIdx: number) => {
        if (!events) return undefined;
        for (let i = askInputsIdx + 1; i < events.length; i++) {
            const candidate = events[i];
            if (candidate.type === "ask_inputs") return undefined;
            if (candidate.type === "ask_inputs_response") return candidate;
        }
        return undefined;
    };

    const hasPendingAskInput = (group: Extract<EventGroup, { kind: "pre" }>) =>
        group.events.some(
            (event, index) =>
                event.type === "ask_inputs" &&
                !askInputsResponseFor(group.indices[index]),
        );

    const renderEvent = (
        event: AssistantEvent,
        i: number,
        allEvents: AssistantEvent[],
        globalIdx: number,
    ) => {
        const nextEvent = allEvents[i + 1];
        const showConnector =
            nextEvent !== undefined && nextEvent.type !== "content";

        if (event.type === "reasoning") {
            return (
                <ReasoningBlock
                    key={globalIdx}
                    text={event.text}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "tool_call_start") {
            return (
                <EventBlock
                    key={globalIdx}
                    showConnector={showConnector}
                    isStreaming
                >
                    <span className="font-medium">
                        {toolCallLabel(event.name)}
                    </span>
                </EventBlock>
            );
        }
        if (event.type === "thinking") {
            return (
                <EventBlock
                    key={globalIdx}
                    showConnector={showConnector}
                    isStreaming
                >
                    <span>Thinking...</span>
                </EventBlock>
            );
        }
        if (event.type === "mcp_tool_call") {
            const isError = event.status === "error";
            const label = event.connector_name
                ? `${event.connector_name}: ${event.tool_name}`
                : toolCallLabel(event.openai_tool_name);
            return (
                <EventBlock
                    key={globalIdx}
                    showConnector={showConnector}
                    isStreaming={event.isStreaming}
                    dotColor={isError ? "red" : "gray"}
                >
                    <span className="font-medium">
                        {event.isStreaming ? "Using connector..." : label}
                    </span>
                    {isError && event.error && (
                        <p className="mt-0.5 text-xs text-red-600">
                            {event.error}
                        </p>
                    )}
                </EventBlock>
            );
        }
        if (event.type === "doc_read") {
            const ann = citations.find(
                (a) => a.kind !== "case" && a.filename === event.filename,
            );
            return (
                <DocReadBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    onClick={
                        !event.isStreaming &&
                        event.document_id &&
                        onOpenDocument
                            ? () =>
                                  onOpenDocument({
                                      documentId: event.document_id!,
                                      filename: event.filename,
                                      versionId: event.version_id ?? null,
                                      versionNumber:
                                          event.version_number ?? null,
                                  })
                            : !event.isStreaming && ann && onCitationClick
                              ? () => onCitationClick(ann)
                              : undefined
                    }
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "doc_find") {
            return (
                <DocFindBlock
                    key={globalIdx}
                    filename={event.filename}
                    query={event.query}
                    totalMatches={event.total_matches}
                    isStreaming={!!event.isStreaming}
                    showConnector={showConnector}
                    onClick={
                        !event.isStreaming &&
                        event.document_id &&
                        onOpenDocument
                            ? () =>
                                  onOpenDocument({
                                      documentId: event.document_id!,
                                      filename: event.filename,
                                      versionId: event.version_id ?? null,
                                      versionNumber:
                                          event.version_number ?? null,
                                  })
                            : undefined
                    }
                />
            );
        }
        if (event.type === "doc_created") {
            return (
                <DocCreatedBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    showConnector={showConnector}
                    onClick={
                        !event.isStreaming &&
                        event.document_id &&
                        onOpenDocument
                            ? () =>
                                  onOpenDocument({
                                      documentId: event.document_id!,
                                      filename: event.filename,
                                      versionId: event.version_id ?? null,
                                      versionNumber:
                                          event.version_number ?? null,
                                  })
                            : undefined
                    }
                />
            );
        }
        if (event.type === "doc_replicated") {
            // The backend now does N copies in one tool call and reports
            // count + copies on a single event, so no consecutive-event
            // aggregation needed.
            return (
                <DocReplicatedBlock
                    key={globalIdx}
                    filename={event.filename}
                    count={event.count}
                    copies={event.copies}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                    onOpenCopy={
                        !event.isStreaming && onOpenDocument
                            ? (copy) =>
                                  onOpenDocument({
                                      documentId: copy.document_id,
                                      filename: copy.new_filename,
                                      versionId: copy.version_id,
                                      versionNumber: 1,
                                  })
                            : undefined
                    }
                />
            );
        }
        if (event.type === "doc_edited") {
            return (
                <DocEditBlock
                    key={globalIdx}
                    filename={event.filename}
                    isStreaming={event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                    onClick={
                        !event.isStreaming &&
                        event.document_id &&
                        onOpenDocument
                            ? () =>
                                  onOpenDocument({
                                      documentId: event.document_id,
                                      filename: event.filename,
                                      versionId: event.version_id || null,
                                      versionNumber:
                                          event.version_number ?? null,
                                  })
                            : undefined
                    }
                />
            );
        }
        if (event.type === "workflow_applied") {
            return (
                <WorkflowAppliedBlock
                    key={globalIdx}
                    title={event.title}
                    showConnector={showConnector}
                    onClick={
                        onWorkflowClick
                            ? () => onWorkflowClick(event.workflow_id)
                            : undefined
                    }
                />
            );
        }
        if (event.type === "ask_inputs") {
            const response = askInputsResponseFor(globalIdx);
            return (
                <AskInputsBlock
                    key={`${globalIdx}-${response ? "complete" : "pending"}`}
                    event={event}
                    response={response}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_search_case_law") {
            const count = event.result_count ?? 0;
            const detail = event.isStreaming
                ? event.query
                    ? `for "${event.query}"`
                    : undefined
                : event.error
                  ? event.error
                  : `${count} ${count === 1 ? "result" : "results"}${event.query ? ` for "${event.query}"` : ""}`;
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? "Searching case law"
                            : event.error
                              ? "Case law search failed"
                              : "Searched case law"
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_get_cases") {
            const caseCount = event.case_count ?? event.cluster_ids.length;
            const displayLabel = `${caseCount} ${
                caseCount === 1 ? "case" : "cases"
            }`;
            const detail = event.error ? event.error : undefined;
            const items: CourtListenerBlockItem[] =
                event.cases?.map((caseItem) => ({
                    caseName: caseItem.case_name,
                    citation: caseItem.citation,
                    url: caseItem.url ?? null,
                })) ??
                event.cluster_ids.map((clusterId) => {
                    const citation = caseCitations.get(`us-case-${clusterId}`);
                    return {
                        caseName: citation?.case_name ?? null,
                        citation: citation?.citation ?? `Cluster ${clusterId}`,
                        url: citation?.url ?? null,
                    };
                });
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? `Fetching ${displayLabel}`
                            : event.error
                              ? "Case fetch failed"
                              : `Fetched ${displayLabel}`
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                    items={items.length > 0 ? items : undefined}
                />
            );
        }
        if (event.type === "courtlistener_find_in_case") {
            const searches = event.searches ?? [];
            if (searches.length > 0) {
                const matches =
                    event.total_matches ??
                    searches.reduce(
                        (sum, search) => sum + (search.total_matches ?? 0),
                        0,
                    );
                const caseIds = new Set(
                    searches.map(
                        (search) =>
                            search.cluster_id ??
                            `${search.case_name ?? ""}|${search.citation ?? ""}`,
                    ),
                );
                const caseCount = caseIds.size || searches.length;
                const searchLabel = `${searches.length} ${
                    searches.length === 1 ? "search" : "searches"
                } in ${caseCount} ${caseCount === 1 ? "case" : "cases"}`;
                const detail = event.isStreaming
                    ? undefined
                    : event.error
                      ? event.error
                      : `(${matches} ${matches === 1 ? "match" : "matches"})`;
                const items: CourtListenerBlockItem[] = searches.map(
                    (search) => ({
                        caseName: search.case_name ?? null,
                        citation:
                            search.citation ??
                            (search.cluster_id
                                ? `Cluster ${search.cluster_id}`
                                : null),
                        url: null,
                        query: search.query,
                        totalMatches: search.total_matches ?? 0,
                        hasError: !!search.error,
                    }),
                );
                return (
                    <CourtListenerBlock
                        key={globalIdx}
                        label={
                            event.isStreaming
                                ? `Running ${searchLabel}`
                                : event.error
                                  ? "Case searches failed"
                                  : `Ran ${searchLabel}`
                        }
                        detail={detail}
                        isStreaming={!!event.isStreaming}
                        hasError={!!event.error}
                        showConnector={showConnector}
                        items={items.length > 0 ? items : undefined}
                    />
                );
            }
            const matches = event.total_matches ?? 0;
            const caseLabel =
                [event.case_name, event.citation].filter(Boolean).join(", ") ||
                (event.cluster_id ? `cluster ${event.cluster_id}` : "case");
            const detail = event.isStreaming
                ? event.query
                    ? `for "${event.query}" in ${caseLabel}`
                    : caseLabel
                : event.error
                  ? event.error
                  : `${matches} ${matches === 1 ? "match" : "matches"}${event.query ? ` for "${event.query}"` : ""} in ${caseLabel}`;
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? "Searching case"
                            : event.error
                              ? "Case search failed"
                              : "Searched case"
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_read_case") {
            const count = event.opinion_count ?? 0;
            const caseLabel =
                [event.case_name, event.citation].filter(Boolean).join(", ") ||
                "case";
            const detail = event.isStreaming
                ? undefined
                : event.error
                  ? event.error
                  : count > 0
                    ? `(${count} ${count === 1 ? "opinion" : "opinions"})`
                    : undefined;
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? `Reading case ${caseLabel}`
                            : event.error
                              ? `Case read failed ${caseLabel}`
                              : `Read case ${caseLabel}`
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                />
            );
        }
        if (event.type === "courtlistener_verify_citations") {
            const citations = event.citation_count ?? 0;
            const matches = event.match_count ?? 0;
            const citationLabel = `${citations} ${citations === 1 ? "citation" : "citations"}`;
            const detail = event.isStreaming
                ? undefined
                : event.error
                  ? event.error
                  : `(${matches} ${matches === 1 ? "match" : "matches"})`;
            // Adjacent `case_citation` events are emitted between the start
            // and final verify_citations events (one per matched citation) —
            // collect them so the user can expand to see resolved cases.
            const items: CourtListenerBlockItem[] = [];
            if (events) {
                for (let j = globalIdx + 1; j < events.length; j++) {
                    const e = events[j];
                    if (e.type !== "case_citation") break;
                    items.push({
                        caseName: e.case_name,
                        citation: e.citation,
                        url: e.url || null,
                    });
                }
            }
            return (
                <CourtListenerBlock
                    key={globalIdx}
                    label={
                        event.isStreaming
                            ? `Verifying ${citationLabel}`
                            : event.error
                              ? "Citation verification failed"
                              : `Verified ${citationLabel}`
                    }
                    detail={detail}
                    isStreaming={!!event.isStreaming}
                    hasError={!!event.error}
                    showConnector={showConnector}
                    items={items.length > 0 ? items : undefined}
                />
            );
        }
        return null;
    };

    return (
        <div style={{ minHeight }}>
            <ResponseStatus status={status} />
            <div className="w-full font-inter relative mt-2">
                {events && events.length > 0 ? (
                    <div className="flex flex-col gap-4">
                        {groups.map((g, gIdx) => {
                            if (g.kind === "content") {
                                const isLastContent =
                                    g.index === lastContentIdx;
                                return (
                                    <div key={`c-${g.index}`}>
                                        <MarkdownContent
                                            text={processedTexts[g.index]}
                                            inlineCitationTargets={
                                                inlineCitationTargets
                                            }
                                            caseCitations={caseCitations}
                                            caseDocuments={caseDocuments}
                                            activeCitation={activeCitation}
                                            onCitationClick={onCitationClick}
                                            onCaseClick={onCaseClick}
                                            divRef={
                                                isLastContent
                                                    ? contentDivRef
                                                    : undefined
                                            }
                                        />
                                    </div>
                                );
                            }
                            const subsequentContent = hasContentAfter(gIdx);
                            const pendingAskInput = hasPendingAskInput(g);
                            const wrapperIsStreaming =
                                g.events.some(
                                    (event) =>
                                        "isStreaming" in event &&
                                        !!event.isStreaming,
                                ) || pendingAskInput;
                            return (
                                <PreResponseWrapper
                                    key={`p-${g.indices[0]}`}
                                    stepCount={g.events.length}
                                    shouldMinimize={
                                        pendingAskInput
                                            ? false
                                            : subsequentContent
                                    }
                                    isStreaming={wrapperIsStreaming}
                                    forceOpen={pendingAskInput}
                                >
                                    {g.events.map((event, i) =>
                                        renderEvent(
                                            event,
                                            i,
                                            g.events,
                                            g.indices[i],
                                        ),
                                    )}
                                </PreResponseWrapper>
                            );
                        })}
                        {/* Bulk accept/reject + per-edit cards — below the
                            response content, only after streaming stops,
                            rendered above the download card. */}
                        {!isStreaming &&
                            (() => {
                                const editedEvents = events.filter(
                                    (e) =>
                                        e.type === "doc_edited" &&
                                        !e.isStreaming,
                                ) as Extract<
                                    AssistantEvent,
                                    { type: "doc_edited" }
                                >[];
                                const pending: {
                                    annotation: EditAnnotation;
                                    filename: string;
                                }[] = [];
                                const filenameByDocId = new Map<
                                    string,
                                    string
                                >();
                                // Effective status = external override if any, else the annotation's DB status.
                                const statusOf = (ann: EditAnnotation) =>
                                    resolvedEditStatuses?.[ann.edit_id] ??
                                    ann.status;
                                for (const e of editedEvents) {
                                    filenameByDocId.set(
                                        e.document_id,
                                        e.filename,
                                    );
                                    for (const ann of e.annotations) {
                                        if (statusOf(ann) === "pending") {
                                            pending.push({
                                                annotation: ann,
                                                filename: e.filename,
                                            });
                                        }
                                    }
                                }
                                let cardIndex = 0;
                                const cards = editedEvents.flatMap((e) =>
                                    e.annotations.map((ann) => {
                                        const changeNumber = ++cardIndex;
                                        return (
                                            <EditCard
                                                key={`editcard-${ann.edit_id}`}
                                                annotation={ann}
                                                changeNumber={changeNumber}
                                                resolvedStatus={
                                                    resolvedEditStatuses?.[
                                                        ann.edit_id
                                                    ]
                                                }
                                                isReloading={
                                                    isEditReloading?.(
                                                        ann.edit_id,
                                                    ) ?? false
                                                }
                                                onViewClick={(a) =>
                                                    onEditViewClick?.(
                                                        a,
                                                        e.filename,
                                                        changeNumber,
                                                    )
                                                }
                                                onResolveStart={
                                                    onEditResolveStart
                                                }
                                                onResolved={handleEditResolved}
                                                onError={onEditError}
                                            />
                                        );
                                    }),
                                );
                                const resolvedCount = editedEvents.reduce(
                                    (acc, e) =>
                                        acc +
                                        e.annotations.filter(
                                            (a) => statusOf(a) !== "pending",
                                        ).length,
                                    0,
                                );
                                // If there's only one edit total, skip the
                                // minimisable wrapper / bulk-actions UI and
                                // render the bare EditCard — no value in
                                // bulk controls for a single item.
                                if (cards.length <= 1) {
                                    return cards;
                                }
                                return (
                                    <EditCardsSection
                                        pending={pending}
                                        filenameByDocId={filenameByDocId}
                                        cards={cards}
                                        resolvedCount={resolvedCount}
                                        onViewClick={
                                            onOpenDocument
                                                ? (annotation, filename) =>
                                                      onOpenDocument({
                                                          documentId:
                                                              annotation.document_id,
                                                          filename,
                                                          versionId:
                                                              annotation.version_id ??
                                                              null,
                                                          versionNumber:
                                                              annotation.version_number ??
                                                              null,
                                                      })
                                                : undefined
                                        }
                                        onResolveStart={onEditResolveStart}
                                        onResolved={handleEditResolved}
                                        onError={onEditError}
                                    />
                                );
                            })()}
                    </div>
                ) : null}

                {topLevelErrorMessage && (
                    <p className="mt-2 text-base font-serif leading-7 text-red-700">
                        {topLevelErrorMessage}
                    </p>
                )}

                {/* Download card for each edited doc — only after streaming
                    stops, and deduped per document (keep the latest edit). */}
                {events &&
                    !isStreaming &&
                    (() => {
                        const edited = events.filter(
                            (
                                e,
                            ): e is Extract<
                                AssistantEvent,
                                { type: "doc_edited" }
                            > =>
                                e.type === "doc_edited" &&
                                !e.isStreaming &&
                                !!e.download_url,
                        );
                        const latestByDoc = new Map<
                            string,
                            (typeof edited)[number]
                        >();
                        for (const e of edited)
                            latestByDoc.set(e.document_id, e);
                        return Array.from(latestByDoc.values()).map((e) => (
                            <div
                                key={`edited-download-${e.document_id}`}
                                className="flex flex-col gap-2 mt-2 mb-3"
                            >
                                <DocDownloadBlock
                                    filename={e.filename}
                                    download_url={
                                        resolvedOverrides[e.document_id] ??
                                        e.download_url
                                    }
                                    versionNumber={e.version_number ?? null}
                                    onOpen={
                                        onOpenDocument
                                            ? () =>
                                                  onOpenDocument({
                                                      documentId: e.document_id,
                                                      filename: e.filename,
                                                      versionId:
                                                          e.version_id ?? null,
                                                      versionNumber:
                                                          e.version_number ??
                                                          null,
                                                  })
                                            : onEditViewClick &&
                                                e.annotations[0]
                                              ? () =>
                                                    onEditViewClick(
                                                        e.annotations[0],
                                                        e.filename,
                                                    )
                                              : undefined
                                    }
                                    isReloading={
                                        isDocReloading?.(e.document_id) ?? false
                                    }
                                />
                            </div>
                        ));
                    })()}

                {/* Download cards for created docs — generated docs now
                    persist as first-class documents, so clicking opens
                    them in the DocPanel (like edited docs). */}
                {events &&
                    !isStreaming &&
                    events.some(
                        (e) => e.type === "doc_created" && e.download_url,
                    ) && (
                        <div className="flex flex-col gap-2 mt-2 mb-3">
                            {(
                                events.filter(
                                    (e) =>
                                        e.type === "doc_created" &&
                                        e.download_url,
                                ) as Extract<
                                    AssistantEvent,
                                    { type: "doc_created" }
                                >[]
                            ).map((e, i) => {
                                const documentId = e.document_id;
                                const versionId = e.version_id ?? null;
                                const versionNumber = e.version_number ?? null;
                                const canOpen =
                                    !!onOpenDocument && !!documentId;
                                return (
                                    <DocDownloadBlock
                                        key={i}
                                        filename={e.filename}
                                        download_url={e.download_url}
                                        versionNumber={versionNumber}
                                        onOpen={
                                            canOpen
                                                ? () =>
                                                      onOpenDocument!({
                                                          documentId:
                                                              documentId!,
                                                          filename: e.filename,
                                                          versionId,
                                                          versionNumber,
                                                      })
                                                : undefined
                                        }
                                    />
                                );
                            })}
                        </div>
                    )}

                {showCitationBlock && (
                    <CitationsBlock
                        citations={citations}
                        activeCitation={activeCitation}
                        onCitationClick={onCitationClick}
                        onOpenSource={handleOpenCitationSource}
                        canOpenSource={canOpenCitationSource}
                        showWhenEmpty={!!citationStatus}
                        isLoading={
                            citationStatus === "started" ||
                            citationStatus === "partial"
                        }
                    />
                )}

                {/* Copy button */}
                <div className="flex items-center gap-2 py-2 font-sans justify-start">
                    {!isStreaming && (
                        <button
                            type="button"
                            aria-label={
                                isCopied ? "Response copied" : "Copy response"
                            }
                            className="p-1.5 rounded text-gray-500 hover:text-gray-700 hover:bg-gray-100"
                            onClick={handleCopy}
                        >
                            {isCopied ? (
                                <Check className="h-3 w-3 text-green-600" />
                            ) : (
                                <Copy className="h-3 w-3" />
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
