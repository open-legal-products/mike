/**
 * Word-chat streaming boundary for the task pane.
 *
 * Passes documentContext through, surfaces answer deltas plus model-triggered
 * document-read lifecycle frames, throws on a pre-`[DONE]` `error` frame, and
 * rejects a response that ends without a terminal `[DONE]`. Framing rules live
 * in the local HTTP client's readSSE.
 *
 * A Word answer is a run the server owns, so it has two entry points that
 * differ only in which response carries the frames: `streamAssistant` (the
 * POST that starts the turn) and `resumeAssistant` (the GET that reattaches
 * to one already running). Both route through the same consumer, so a
 * reattached pane handles everything a fresh one does, client tool calls
 * included.
 */
import { streamWordChat, streamWordChatTurn, readSSE } from "./mikeApi";
import type { ReasoningLevel } from "../lib/wordChatTypes";

export interface WordChatDocumentReadEvent {
  type: "doc_read_start" | "doc_read";
  filename: string;
  documentId?: string;
}

/**
 * A tool call the backend forwarded for execution inside Word. The pane runs
 * it with Office.js and posts the outcome to /word-chat/tool-result, keyed by
 * `toolCallId`; the backend's tool loop is blocked awaiting that post.
 */
export interface WordClientToolCall {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The stream ended without its terminal `[DONE]`.
 *
 * Distinct from an `error` frame, which is the server reporting a finished,
 * failed turn: this one means the TRANSPORT went away while the server-owned
 * turn kept generating, so the caller should rejoin it rather than give up.
 */
export class WordChatStreamInterrupted extends Error {
  constructor() {
    super("Chat stream ended before the completion marker.");
    this.name = "WordChatStreamInterrupted";
  }
}

/** Everything a turn's frames are routed to, whichever response carries them. */
export interface WordTurnHandlers {
  /**
   * The turn's identity as the server reports it. `turnId` is what the pane
   * stops and what it reattaches to.
   */
  onMetadata?: (metadata: {
    chatId?: string;
    turnId?: string;
    assistantMessageId?: string;
  }) => void;
  /** Streams the model's user-visible reasoning summary in arrival order. */
  onReasoningDelta?: (text: string) => void;
  /** Finalizes the current reasoning block before the next activity. */
  onReasoningBlockEnd?: () => void;
  /** Called only when the backend reports a model-triggered document read. */
  onDocumentRead?: (event: WordChatDocumentReadEvent) => void;
  /**
   * Called when the backend forwards a client-executed tool call. The
   * handler must eventually post a result for `toolCallId` (success or
   * error) — the backend times the call out otherwise. Passing this handler
   * is what advertises `client_tools` capability to the backend.
   */
  onClientToolCall?: (call: WordClientToolCall) => void;
  /**
   * Streams the citation rows behind the answer's `[n]` markers. Fired per
   * citations frame; the final frame supersedes earlier partial ones.
   */
  onCitations?: (citations: unknown[]) => void;
  /** The sequence number of each frame applied, for a reconnect's `from`. */
  onEventId?: (seq: number) => void;
}

/**
 * Route one response's frames to the handlers and enforce the terminal
 * `[DONE]`.
 *
 * Shared by both ends of a turn — the POST that starts it and the GET that
 * reattaches to it — so a resumed turn behaves identically to the one it
 * resumed, tool calls included.
 */
async function consumeTurnStream(
  res: Response,
  params: WordTurnHandlers & { signal?: AbortSignal },
  onText: (text: string) => void,
): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Chat request failed (${res.status}): ${body}`);
  }
  let streamError: string | null = null;
  const result = await readSSE(
    res,
    (data) => {
      const d = data as Record<string, unknown>;
      if (d.type === "content_delta" && typeof d.text === "string" && d.text) {
        onText(d.text);
      } else if (
        d.type === "reasoning_delta" &&
        typeof d.text === "string" &&
        d.text
      ) {
        params.onReasoningDelta?.(d.text);
      } else if (d.type === "reasoning_block_end") {
        params.onReasoningBlockEnd?.();
      } else if (d.type === "chat_id") {
        const chatId = typeof d.chatId === "string" ? d.chatId : undefined;
        const turnId = typeof d.turnId === "string" ? d.turnId : undefined;
        const assistantMessageId =
          typeof d.assistantMessageId === "string"
            ? d.assistantMessageId
            : undefined;
        if (chatId || turnId || assistantMessageId) {
          params.onMetadata?.({ chatId, turnId, assistantMessageId });
        }
      } else if (
        d.type === "client_tool_call" &&
        typeof d.tool_call_id === "string" &&
        d.tool_call_id &&
        typeof d.name === "string" &&
        d.name
      ) {
        params.onClientToolCall?.({
          toolCallId: d.tool_call_id,
          name: d.name,
          input:
            d.input && typeof d.input === "object" && !Array.isArray(d.input)
              ? (d.input as Record<string, unknown>)
              : {},
        });
      } else if (
        (d.type === "doc_read_start" || d.type === "doc_read") &&
        typeof d.filename === "string" &&
        d.filename
      ) {
        params.onDocumentRead?.({
          type: d.type,
          filename: d.filename,
          ...(typeof d.document_id === "string" && d.document_id
            ? { documentId: d.document_id }
            : {}),
        });
      } else if (d.type === "citations" && Array.isArray(d.citations)) {
        params.onCitations?.(d.citations);
      } else if (d.type === "error") {
        streamError =
          typeof d.message === "string" ? d.message : "Stream error";
      }
    },
    {
      signal: params.signal,
      onEventId: (id) => {
        const seq = Number.parseInt(id, 10);
        if (Number.isFinite(seq)) params.onEventId?.(seq);
      },
    },
  );
  if (streamError) throw new Error(streamError);
  if (!result.done && !params.signal?.aborted) {
    throw new WordChatStreamInterrupted();
  }
}

/**
 * Reattach to a turn the server is already generating (or has just
 * finished): the buffered frames from `from` onwards are replayed, then the
 * live ones follow. Used by a pane that reopens on a chat whose answer is
 * still running and by a stream that dropped mid-answer.
 */
export async function resumeAssistant(
  params: WordTurnHandlers & {
    chatId: string;
    turnId: string;
    documentId: string;
    from?: number;
    signal?: AbortSignal;
  },
  onText: (text: string) => void,
): Promise<void> {
  const res = await streamWordChatTurn({
    chatId: params.chatId,
    turnId: params.turnId,
    documentId: params.documentId,
    from: params.from ?? 1,
    signal: params.signal,
  });
  await consumeTurnStream(res, params, onText);
}

export async function streamAssistant(
  params: WordTurnHandlers & {
    messages: {
      role: string;
      content: string;
      files?: { filename: string; document_id?: string }[];
      // Workflow runs travel as a reference — the backend resolves the body
      // server-side (inside the <workflow-instructions> fence), same as the web.
      workflow?: { id: string; title: string };
    }[];
    documentContext?: string;
    model: string;
    reasoning?: ReasoningLevel;
    chatId?: string;
    wordDocumentId: string;
    documentName: string;
    wordChatStorage: "cloud" | "local";
    editApplyMode?: "direct" | "approval";
    signal?: AbortSignal;
  },
  onText: (text: string) => void,
): Promise<void> {
  const res = await streamWordChat({
    messages: params.messages,
    model: params.model,
    reasoning: params.reasoning,
    chat_id: params.chatId,
    document_context: params.documentContext,
    document_id: params.wordDocumentId,
    document_name: params.documentName,
    storage: params.wordChatStorage,
    edit_apply_mode: params.editApplyMode ?? "approval",
    // Capability is advertised by the code that can actually honour it, so
    // the flag can never drift from the implementation.
    client_tools: !!params.onClientToolCall,
    signal: params.signal,
  });
  await consumeTurnStream(res, params, onText);
}
