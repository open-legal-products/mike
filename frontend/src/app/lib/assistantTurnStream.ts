"use client";

import { streamChatTurn } from "@/app/lib/mikeApi";
import { readSseFrames } from "@/app/lib/sse";
import { isPanelDocument } from "@/app/components/shared/types";
import type { AssistantEvent, Citation } from "@/app/components/shared/types";
import type { AssistantTurnHandle } from "@/app/lib/assistantTurns";

/**
 * Reading an assistant turn's SSE stream into its turn record.
 *
 * This is the half of `useAssistantChat` that has nothing to do with React.
 * It exists as its own module because a turn is now server-owned: the page
 * that sent the request may be gone (a refresh, a closed tab) while the
 * server keeps generating, and the page that loads next attaches to the
 * turn by id with no hook and no request of its own. Both paths — the
 * original POST and a `GET .../turn/:id/stream` resume — feed the same
 * frame loop, and the loop writes only to the turn record; whatever a host
 * needs to do with a frame (adopt a chat id, refresh a sidebar title) goes
 * through `hooks`.
 *
 * Frames carry SSE ids (the server's sequence numbers). The cursor keeps
 * the last one seen so a dropped connection is resumed from the next frame
 * rather than started over, and so Stop can name the turn to the server.
 */

export type TurnCursor = {
  chatId?: string;
  turnId?: string;
  /** Sequence number of the last frame applied; 0 before any. */
  lastSeq: number;
};

export function createTurnCursor(chatId?: string): TurnCursor {
  return { chatId, lastSeq: 0 };
}

export type TurnStreamHooks = {
  onChatId?: (chatId: string, assistantMessageId?: string) => void;
  onChatTitle?: (chatId: string, title: string) => void;
  onRejectedApiKey?: () => void;
  /** The server sent an `error` frame; the turn is over as far as the model goes. */
  onErrorFrame?: () => void;
};

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function readableStreamError(value: unknown, safeToDisplay: boolean): string {
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
        cluster_id: typeof row.cluster_id === "number" ? row.cluster_id : 0,
        case_name: typeof row.case_name === "string" ? row.case_name : null,
        citation: typeof row.citation === "string" ? row.citation : null,
        dateFiled: typeof row.dateFiled === "string" ? row.dateFiled : null,
        url: typeof row.url === "string" ? row.url : null,
      };
    })
    .filter(
      (item): item is NonNullable<typeof item> => !!item && item.cluster_id > 0,
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
        cluster_id: typeof row.cluster_id === "number" ? row.cluster_id : null,
        query: typeof row.query === "string" ? row.query : "",
        total_matches:
          typeof row.total_matches === "number" ? row.total_matches : 0,
        case_name: typeof row.case_name === "string" ? row.case_name : null,
        citation: typeof row.citation === "string" ? row.citation : null,
        error: typeof row.error === "string" ? row.error : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => !!item);
}

/**
 * Builds one turn's assistant message from its stream.
 *
 * Everything here writes to the turn record, never to a hook's state. The
 * hook that sent the request may have moved to another thread or unmounted
 * by the time a frame arrives, and a hook that has come back to the thread
 * renders the same record — so the record is the one place the answer lives
 * while it streams.
 */
export function createTurnEventSink(
  turn: AssistantTurnHandle,
  initialEvents: AssistantEvent[],
) {
  const eventsRef = { current: initialEvents };
  const publish = () => {
    const snapshot = [...eventsRef.current];
    turn.update((message) => ({ ...message, events: snapshot }));
  };

  /**
   * Finalize any in-flight streaming content event so the next
   * content_delta starts a fresh block. Called
   * before any non-content event is appended, so interleaved content /
   * reasoning / tool events stay in chronological order — without the
   * later content block inheriting the earlier block's accumulated text.
   */
  const finalizeStreamingContent = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type === "content" && last.isStreaming) {
      eventsRef.current = [
        ...events.slice(0, -1),
        { type: "content", text: last.text },
      ];
      publish();
    }
  };

  // If the model transitions from reasoning into content/tool without a
  // reasoning_block_end (or the events arrive out of order), the prior
  // reasoning event would otherwise stay flagged isStreaming forever.
  const finalizeStreamingReasoning = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    if (last?.type !== "reasoning" || !last.isStreaming) return;
    eventsRef.current = [
      ...events.slice(0, -1),
      { type: "reasoning", text: last.text },
    ];
    publish();
  };

  // Transient placeholder events (tool_call_start, thinking) fill the
  // latency gap between real SSE events so the wrapper doesn't look stuck.
  // Anytime a real event arrives, drop any streaming placeholder first.
  const isStreamingPlaceholder = (e: AssistantEvent) =>
    (e.type === "tool_call_start" || e.type === "thinking") && !!e.isStreaming;

  const cancelStreamingEvents = (events: AssistantEvent[]) =>
    events
      .filter((event) => !isStreamingPlaceholder(event))
      .map((event) => {
        if (!("isStreaming" in event) || !event.isStreaming) return event;
        const rest = { ...event };
        delete (rest as { isStreaming?: boolean }).isStreaming;
        return rest as AssistantEvent;
      });

  // Stop may reach the record twice: from the control itself and from the
  // aborted request unwinding. The label goes on once.
  let cancelled = false;
  const appendCancellation = () => {
    if (cancelled) return;
    cancelled = true;
    eventsRef.current = [
      ...cancelStreamingEvents(eventsRef.current),
      { type: "content" as const, text: "Cancelled by user." },
    ];
    publish();
  };

  const clearStreamingPlaceholders = () => {
    const before = eventsRef.current;
    const after = before.filter((e) => !isStreamingPlaceholder(e));
    if (after.length === before.length) return;
    eventsRef.current = after;
    publish();
  };

  const pushThinkingPlaceholder = () => {
    const events = eventsRef.current;
    const last = events[events.length - 1];
    // Don't stack placeholders back-to-back; one "Thinking…" line is plenty.
    if (last && isStreamingPlaceholder(last)) return;
    eventsRef.current = [
      ...events,
      { type: "thinking" as const, isStreaming: true },
    ];
    publish();
  };

  const pushEvent = (event: AssistantEvent) => {
    finalizeStreamingContent();
    finalizeStreamingReasoning();
    // A real event, or a more specific placeholder such as
    // tool_call_start, should replace any generic "Thinking..." line.
    const next = eventsRef.current.filter((e) => !isStreamingPlaceholder(e));
    eventsRef.current = [...next, event];
    publish();
  };

  const updateMatchingEvent = (
    predicate: (e: AssistantEvent) => boolean,
    updater: (e: AssistantEvent) => AssistantEvent,
  ) => {
    const events = eventsRef.current;
    const idx = [...events]
      .map((_, i) => i)
      .reverse()
      .find((i) => predicate(events[i]));
    if (idx === undefined) return false;
    const newEvents = [...events];
    newEvents[idx] = updater(events[idx]);
    eventsRef.current = newEvents;
    publish();
    return true;
  };

  return {
    eventsRef,
    finalizeStreamingContent,
    finalizeStreamingReasoning,
    clearStreamingPlaceholders,
    pushThinkingPlaceholder,
    pushEvent,
    updateMatchingEvent,
    appendCancellation,
  };
}

export type TurnEventSink = ReturnType<typeof createTurnEventSink>;

/** Apply one stream's frames to the turn record until [DONE] or the signal aborts. */
export async function consumeAssistantTurnStream(
  response: Response,
  args: {
    turn: AssistantTurnHandle;
    sink: TurnEventSink;
    cursor: TurnCursor;
    signal?: AbortSignal;
    hooks?: TurnStreamHooks;
  },
): Promise<void> {
  const { turn, sink, cursor, signal } = args;
  const hooks = args.hooks ?? {};
  const {
    eventsRef,
    finalizeStreamingContent,
    finalizeStreamingReasoning,
    clearStreamingPlaceholders,
    pushThinkingPlaceholder,
    pushEvent,
    updateMatchingEvent,
    appendCancellation,
  } = sink;
  const updateLatestAssistantMessage = turn.update;

  for await (const frame of readSseFrames(response, {
    signal,
    onEventId: (id) => {
      const seq = Number.parseInt(id, 10);
      if (Number.isFinite(seq)) cursor.lastSeq = seq;
    },
  })) {
    const data = frame as Record<string, unknown>;

    try {
        if (data.type === "chat_id") {
          const streamed = data.chatId as string;
          const assistantMessageId =
            typeof data.assistantMessageId === "string"
              ? data.assistantMessageId
              : undefined;
          cursor.chatId = streamed;
          if (typeof data.turnId === "string") cursor.turnId = data.turnId;
          turn.identify(streamed, assistantMessageId);
          hooks.onChatId?.(streamed, assistantMessageId);
          continue;
        }

        if (data.type === "cancelled") {
          // Stop was pressed, here or in another tab. The server stores
          // the partial answer with the same label.
          appendCancellation();
          continue;
        }

        if (
          data.type === "chat_title" &&
          typeof data.chatId === "string" &&
          typeof data.title === "string"
        ) {
          hooks.onChatTitle?.(data.chatId, data.title);
          continue;
        }

        if (data.type === "content_done") {
          turn.setLoadingCitations(true);
          continue;
        }

        if (data.type === "error") {
          const safeToDisplay = data.safe_to_display === true;
          const message = readableStreamError(
            data.message,
            safeToDisplay,
          );
          // A rejected key cannot be fixed by retrying, so raise it as a
          // signal the surface can turn into "go fix your key" rather than
          // leaving it as one more line of failed-response text.
          if (data.code === "invalid_api_key") hooks.onRejectedApiKey?.();
          clearStreamingPlaceholders();
          finalizeStreamingContent();
          finalizeStreamingReasoning();
          eventsRef.current = [
            ...eventsRef.current,
            {
              type: "error",
              message,
              ...(safeToDisplay ? { safe_to_display: true } : {}),
              ...(data.code === "invalid_api_key"
                ? { code: "invalid_api_key" as const }
                : {}),
            },
          ];
          const snapshot = [...eventsRef.current];
          updateLatestAssistantMessage((assistantMessage) => ({
            ...assistantMessage,
            events: snapshot,
            error: message,
          }));
          turn.setLoadingCitations(false);
          hooks.onErrorFrame?.();
          continue;
        }

        if (data.type === "content_delta") {
          const text = data.text as string;

          // Real content is streaming — retire any
          // "Thinking…" / "Running…" placeholders, and
          // finalize any in-flight reasoning block so it
          // doesn't get stuck rendering as streaming.
          clearStreamingPlaceholders();
          finalizeStreamingReasoning();

          // Ensure a streaming content event exists. If
          // the last event isn't already a streaming
          // content block, start a fresh one so interleaved
          // tool/reasoning events split content naturally.
          const events = eventsRef.current;
          const lastEvent = events[events.length - 1];
          if (lastEvent?.type !== "content" || !lastEvent.isStreaming) {
            eventsRef.current = [
              ...events,
              {
                type: "content" as const,
                text,
                isStreaming: true,
              },
            ];
            const snapshot = [...eventsRef.current];
            updateLatestAssistantMessage((message) => ({
              ...message,
              events: snapshot,
            }));
          } else {
            const nextEvents = [...events];
            nextEvents[nextEvents.length - 1] = {
              type: "content" as const,
              text: `${lastEvent.text}${text}`,
              isStreaming: true,
            };
            eventsRef.current = nextEvents;
            const snapshot = [...nextEvents];
            updateLatestAssistantMessage((message) => ({
              ...message,
              events: snapshot,
            }));
          }
          continue;
        }

        if (data.type === "reasoning_delta") {
          const text = data.text as string;
          let events = eventsRef.current;
          const last = events[events.length - 1];
          if (last?.type === "reasoning" && last.isStreaming) {
            eventsRef.current = [
              ...events.slice(0, -1),
              {
                type: "reasoning" as const,
                text: last.text + text,
                isStreaming: true,
              },
            ];
          } else {
            // New reasoning block — finalize any in-flight
            // content event first so the next content_delta
            // starts a fresh block at the correct position.
            finalizeStreamingContent();
            clearStreamingPlaceholders();
            events = eventsRef.current;
            eventsRef.current = [
              ...events,
              {
                type: "reasoning" as const,
                text,
                isStreaming: true,
              },
            ];
          }
          const snapshot = [...eventsRef.current];
          updateLatestAssistantMessage((message) => ({
            ...message,
            events: snapshot,
          }));
          continue;
        }

        if (data.type === "reasoning_block_end") {
          const events = eventsRef.current;
          const last = events[events.length - 1];
          if (last?.type === "reasoning" && last.isStreaming) {
            eventsRef.current = [
              ...events.slice(0, -1),
              {
                type: "reasoning" as const,
                text: last.text,
              },
            ];
          }
          const snapshot = [...eventsRef.current];
          updateLatestAssistantMessage((message) => ({
            ...message,
            events: snapshot,
          }));
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "tool_call_start") {
          // Transient placeholder so the client immediately
          // shows activity after Claude ends a turn with
          // tool_use. Replaced by the real tool event
          // (doc_edited_start, doc_read_start, …) if one
          // arrives; otherwise it lingers as a "Working…"
          // indicator until the next iteration streams.
          pushEvent({
            type: "tool_call_start",
            name: (data.name as string) ?? "",
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "workflow_applied") {
          pushEvent({
            type: "workflow_applied",
            workflow_id: data.workflow_id as string,
            title: data.title as string,
          });
          continue;
        }

        if (data.type === "case_citation") {
          pushEvent({
            type: "case_citation",
            cluster_id:
              typeof data.cluster_id === "number"
                ? (data.cluster_id as number)
                : null,
            case_name:
              typeof data.case_name === "string"
                ? (data.case_name as string)
                : null,
            citation:
              typeof data.citation === "string"
                ? (data.citation as string)
                : null,
            url: data.url as string,
            pdfUrl:
              typeof data.pdfUrl === "string"
                ? (data.pdfUrl as string)
                : null,
            dateFiled:
              typeof data.dateFiled === "string"
                ? (data.dateFiled as string)
                : null,
            document: isPanelDocument(data.document)
                ? data.document
                : undefined,
          });
          continue;
        }

        if (data.type === "case_opinions") {
          pushEvent({
            type: "case_opinions",
            cluster_id:
              typeof data.cluster_id === "number"
                ? (data.cluster_id as number)
                : 0,
            document: isPanelDocument(data.document)
                ? data.document
                : undefined,
          });
          continue;
        }

        if (data.type === "mcp_tool_start") {
          pushEvent({
            type: "mcp_tool_call",
            connector_id: "",
            connector_name: "",
            tool_name: (data.name as string) ?? "",
            openai_tool_name: (data.name as string) ?? "",
            status: "ok",
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "mcp_tool_result") {
          const openaiToolName = (data.name as string) ?? "";
          updateMatchingEvent(
            (e) =>
              e.type === "mcp_tool_call" &&
              e.openai_tool_name === openaiToolName &&
              !!e.isStreaming,
            () => ({
              type: "mcp_tool_call",
              connector_id: "",
              connector_name:
                typeof data.connector_name === "string"
                  ? (data.connector_name as string)
                  : "",
              tool_name:
                typeof data.tool_name === "string"
                  ? (data.tool_name as string)
                  : openaiToolName,
              openai_tool_name: openaiToolName,
              status: data.status === "error" ? "error" : "ok",
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "courtlistener_search_case_law_start") {
          pushEvent({
            type: "courtlistener_search_case_law",
            query: (data.query as string) ?? "",
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "courtlistener_search_case_law") {
          updateMatchingEvent(
            (e) =>
              e.type === "courtlistener_search_case_law" &&
              e.query === (data.query as string) &&
              !!e.isStreaming,
            () => ({
              type: "courtlistener_search_case_law",
              query: (data.query as string) ?? "",
              result_count:
                typeof data.result_count === "number"
                  ? (data.result_count as number)
                  : 0,
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "courtlistener_get_cases_start") {
          pushEvent({
            type: "courtlistener_get_cases",
            cluster_ids: Array.isArray(data.cluster_ids)
              ? (data.cluster_ids as unknown[]).filter(
                  (value: unknown): value is number =>
                    typeof value === "number",
                )
              : [],
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "courtlistener_get_cases") {
          updateMatchingEvent(
            (e) => e.type === "courtlistener_get_cases" && !!e.isStreaming,
            () => ({
              type: "courtlistener_get_cases",
              cluster_ids: Array.isArray(data.cluster_ids)
                ? (data.cluster_ids as unknown[]).filter(
                    (value: unknown): value is number =>
                      typeof value === "number",
                  )
                : [],
              case_count:
                typeof data.case_count === "number"
                  ? (data.case_count as number)
                  : 0,
              opinion_count:
                typeof data.opinion_count === "number"
                  ? (data.opinion_count as number)
                  : 0,
              cases: parseCourtlistenerEventCases(data.cases),
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "courtlistener_find_in_case_start") {
          const searches = parseCourtlistenerCaseSearches(data.searches);
          pushEvent({
            type: "courtlistener_find_in_case",
            cluster_id: searches?.length
              ? null
              : typeof data.cluster_id === "number"
                ? (data.cluster_id as number)
                : null,
            query: searches?.length ? "" : ((data.query as string) ?? ""),
            searches,
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "courtlistener_find_in_case") {
          const searches = parseCourtlistenerCaseSearches(data.searches);
          updateMatchingEvent(
            (e) =>
              e.type === "courtlistener_find_in_case" &&
              (searches?.length
                ? Array.isArray(e.searches)
                : e.cluster_id ===
                    (typeof data.cluster_id === "number"
                      ? (data.cluster_id as number)
                      : null) && e.query === (data.query as string)) &&
              !!e.isStreaming,
            () => ({
              type: "courtlistener_find_in_case",
              cluster_id: searches?.length
                ? null
                : typeof data.cluster_id === "number"
                  ? (data.cluster_id as number)
                  : null,
              query: searches?.length ? "" : ((data.query as string) ?? ""),
              total_matches:
                typeof data.total_matches === "number"
                  ? (data.total_matches as number)
                  : 0,
              searches,
              case_name:
                typeof data.case_name === "string"
                  ? (data.case_name as string)
                  : null,
              citation:
                typeof data.citation === "string"
                  ? (data.citation as string)
                  : null,
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "courtlistener_read_case_start") {
          pushEvent({
            type: "courtlistener_read_case",
            cluster_id:
              typeof data.cluster_id === "number"
                ? (data.cluster_id as number)
                : null,
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "courtlistener_read_case") {
          updateMatchingEvent(
            (e) =>
              e.type === "courtlistener_read_case" &&
              e.cluster_id ===
                (typeof data.cluster_id === "number"
                  ? (data.cluster_id as number)
                  : null) &&
              !!e.isStreaming,
            () => ({
              type: "courtlistener_read_case",
              cluster_id:
                typeof data.cluster_id === "number"
                  ? (data.cluster_id as number)
                  : null,
              case_name:
                typeof data.case_name === "string"
                  ? (data.case_name as string)
                  : null,
              citation:
                typeof data.citation === "string"
                  ? (data.citation as string)
                  : null,
              opinion_count:
                typeof data.opinion_count === "number"
                  ? (data.opinion_count as number)
                  : 0,
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "courtlistener_verify_citations_start") {
          pushEvent({
            type: "courtlistener_verify_citations",
            citation_count:
              typeof data.citation_count === "number"
                ? (data.citation_count as number)
                : 0,
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "courtlistener_verify_citations") {
          updateMatchingEvent(
            (e) =>
              e.type === "courtlistener_verify_citations" &&
              !!e.isStreaming,
            () => ({
              type: "courtlistener_verify_citations",
              citation_count:
                typeof data.citation_count === "number"
                  ? (data.citation_count as number)
                  : 0,
              match_count:
                typeof data.match_count === "number"
                  ? (data.match_count as number)
                  : 0,
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "doc_read_start") {
          pushEvent({
            type: "doc_read",
            filename: data.filename as string,
            document_id:
              typeof data.document_id === "string"
                ? (data.document_id as string)
                : undefined,
            version_id:
              typeof data.version_id === "string"
                ? (data.version_id as string)
                : null,
            version_number:
              typeof data.version_number === "number"
                ? (data.version_number as number)
                : null,
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "ask_inputs") {
          const eventId =
            typeof data.event_id === "string" ? data.event_id.trim() : "";
          const rawItems = Array.isArray(data.items)
            ? (data.items as unknown[])
            : [];
          const items = rawItems.reduce<
            Extract<AssistantEvent, { type: "ask_inputs" }>["items"]
          >((acc, item, index) => {
            if (!item || typeof item !== "object") return acc;
            const row = item as Record<string, unknown>;
            const id =
              typeof row.id === "string" && row.id.trim()
                ? row.id.trim()
                : `input-${index + 1}`;
            if (
              row.kind === "choice" ||
              row.kind === "multi_choice"
            ) {
              const options = Array.isArray(row.options)
                ? (row.options as unknown[]).flatMap((option) => {
                    if (!option || typeof option !== "object") return [];
                    const optionRow = option as Record<string, unknown>;
                    const value =
                      typeof optionRow.value === "string"
                        ? optionRow.value
                        : typeof optionRow.label === "string"
                          ? optionRow.label
                          : "";
                    if (!value.trim()) return [];
                    return [
                      {
                        value,
                      },
                    ];
                  })
                : [];
              acc.push({
                id,
                kind: row.kind,
                question:
                  typeof row.question === "string"
                    ? row.question
                    : row.kind === "multi_choice"
                      ? "Please choose one or more options."
                      : "Please choose an option.",
                options,
                allow_other: row.allow_other !== false,
                other_label:
                  typeof row.other_label === "string"
                    ? row.other_label
                    : "Other",
                response_prefix:
                  typeof row.response_prefix === "string"
                    ? row.response_prefix
                    : undefined,
              });
              return acc;
            }
            if (row.kind === "text") {
              acc.push({
                id,
                kind: "text" as const,
                question:
                  typeof row.question === "string"
                    ? row.question
                    : "Please provide the requested information.",
                response_prefix:
                  typeof row.response_prefix === "string"
                    ? row.response_prefix
                    : undefined,
              });
              return acc;
            }
            if (row.kind === "documents") {
              const documentTypes = Array.isArray(row.document_types)
                ? (row.document_types as unknown[])
                    .filter(
                      (type): type is string => typeof type === "string",
                    )
                    .map((type) => type.trim())
                    .filter(Boolean)
                : [];
              acc.push({
                id,
                kind: "documents" as const,
                document_types: documentTypes,
                response_prefix:
                  typeof row.response_prefix === "string"
                    ? row.response_prefix
                    : undefined,
              });
              return acc;
            }
            return acc;
          }, []);
          if (eventId && items.length > 0) {
            pushEvent({ type: "ask_inputs", event_id: eventId, items });
          }
          continue;
        }

        if (data.type === "doc_read") {
          updateMatchingEvent(
            (e) =>
              e.type === "doc_read" &&
              e.filename === data.filename &&
              !!e.isStreaming,
            (e) => {
              const event = e as Extract<
                AssistantEvent,
                { type: "doc_read" }
              >;
              return {
                ...event,
                document_id:
                  typeof data.document_id === "string"
                    ? (data.document_id as string)
                    : event.document_id,
                version_id:
                  typeof data.version_id === "string"
                    ? (data.version_id as string)
                    : event.version_id,
                version_number:
                  typeof data.version_number === "number"
                    ? (data.version_number as number)
                    : event.version_number,
                isStreaming: false,
              };
            },
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "doc_find_start") {
          pushEvent({
            type: "doc_find",
            filename: data.filename as string,
            document_id:
              typeof data.document_id === "string"
                ? (data.document_id as string)
                : undefined,
            version_id:
              typeof data.version_id === "string"
                ? (data.version_id as string)
                : null,
            version_number:
              typeof data.version_number === "number"
                ? (data.version_number as number)
                : null,
            query: (data.query as string) ?? "",
            total_matches: 0,
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "doc_find") {
          updateMatchingEvent(
            (e) =>
              e.type === "doc_find" &&
              e.filename === data.filename &&
              e.query === (data.query as string) &&
              !!e.isStreaming,
            (e) => {
              const event = e as Extract<
                AssistantEvent,
                { type: "doc_find" }
              >;
              return {
                ...event,
                document_id:
                  typeof data.document_id === "string"
                    ? (data.document_id as string)
                    : event.document_id,
                version_id:
                  typeof data.version_id === "string"
                    ? (data.version_id as string)
                    : event.version_id,
                version_number:
                  typeof data.version_number === "number"
                    ? (data.version_number as number)
                    : event.version_number,
                isStreaming: false,
                total_matches:
                  typeof data.total_matches === "number"
                    ? (data.total_matches as number)
                    : event.total_matches,
              };
            },
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "doc_created_start") {
          pushEvent({
            type: "doc_created",
            filename: data.filename as string,
            download_url: "",
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "doc_download") {
          pushEvent({
            type: "doc_download",
            filename: data.filename as string,
            download_url: data.download_url as string,
          });
          continue;
        }

        if (data.type === "doc_created") {
          updateMatchingEvent(
            (e) =>
              e.type === "doc_created" &&
              e.filename === data.filename &&
              !!e.isStreaming,
            (e) => {
              const next: Extract<AssistantEvent, { type: "doc_created" }> =
                {
                  type: "doc_created",
                  filename: (e as { filename: string }).filename,
                  download_url: data.download_url as string,
                  isStreaming: false,
                };
              if (typeof data.document_id === "string") {
                next.document_id = data.document_id as string;
              }
              if (typeof data.version_id === "string") {
                next.version_id = data.version_id as string;
              }
              if (typeof data.version_number === "number") {
                next.version_number = data.version_number as number;
              }
              return next;
            },
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "doc_replicate_start") {
          pushEvent({
            type: "doc_replicated",
            filename: data.filename as string,
            count:
              typeof data.count === "number" ? (data.count as number) : 1,
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "doc_replicated") {
          updateMatchingEvent(
            (e) =>
              e.type === "doc_replicated" &&
              e.filename === data.filename &&
              !!e.isStreaming,
            () => ({
              type: "doc_replicated",
              filename: data.filename as string,
              count:
                typeof data.count === "number"
                  ? (data.count as number)
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
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "doc_edited_start") {
          pushEvent({
            type: "doc_edited",
            filename: data.filename as string,
            document_id: "",
            version_id: "",
            download_url: "",
            annotations: [],
            isStreaming: true,
          });
          continue;
        }

        if (data.type === "doc_edited") {
          updateMatchingEvent(
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
                  ? (data.version_number as number)
                  : null,
              download_url: (data.download_url as string) ?? "",
              annotations: Array.isArray(data.annotations)
                ? (data.annotations as import("@/app/components/shared/types").EditAnnotation[])
                : [],
              error:
                typeof data.error === "string"
                  ? (data.error as string)
                  : undefined,
              isStreaming: false,
            }),
          );
          pushThinkingPlaceholder();
          continue;
        }

        if (data.type === "citations") {
          const status =
            data.status === "started" ||
            data.status === "partial" ||
            data.status === "final"
              ? data.status
              : "final";
          const incoming = (data.citations ?? []) as Citation[];
          if (status === "started" || status === "partial") {
            updateLatestAssistantMessage((message) => ({
              ...message,
              citations: incoming,
              citationStatus: status,
            }));
            continue;
          }
          // End-of-stream signal — scrub any lingering
          // placeholders so they don't persist into the
          // finalised message. First finalize content so adding
          // citations cannot re-render the markdown/citation view
          // against a streaming block.
          finalizeStreamingContent();
          clearStreamingPlaceholders();
          updateLatestAssistantMessage((message) => ({
            ...message,
            citations: incoming,
            citationStatus: incoming.length ? "final" : undefined,
          }));
          continue;
        }
    } catch (e) {
      console.warn("[useAssistantChat] failed to handle SSE event:", data, e);
    }
  }

  finalizeStreamingReasoning();
}

/**
 * Read a turn to its end, reconnecting to the server's copy of it when the
 * connection drops. `open` produces the first response (the POST that starts
 * the turn, or a resume GET); after that, every retry is a resume from the
 * frame after the last one seen. An abort — Stop — is never retried, and
 * neither is a turn the server no longer knows (a 404 after the retention
 * window), which surfaces the original failure.
 */
export async function readAssistantTurn(args: {
  open: () => Promise<Response>;
  turn: AssistantTurnHandle;
  sink: TurnEventSink;
  cursor: TurnCursor;
  signal?: AbortSignal;
  hooks?: TurnStreamHooks;
  /** Reconnect attempts after the first response (default 2). */
  retries?: number;
}): Promise<void> {
  const { turn, sink, cursor, signal, hooks } = args;
  const retries = args.retries ?? 2;
  let response = await args.open();
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Chat request failed with status ${response.status}`);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await consumeAssistantTurnStream(response, { turn, sink, cursor, signal, hooks });
      return;
    } catch (error) {
      if (
        isAbortError(error) ||
        signal?.aborted ||
        !cursor.chatId ||
        !cursor.turnId ||
        attempt >= retries
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      if (signal?.aborted) throw error;
      const resumed = await streamChatTurn({
        chatId: cursor.chatId,
        turnId: cursor.turnId,
        from: cursor.lastSeq + 1,
        signal,
      });
      if (!resumed.ok) {
        await resumed.body?.cancel().catch(() => {});
        throw error;
      }
      response = resumed;
    }
  }
}
