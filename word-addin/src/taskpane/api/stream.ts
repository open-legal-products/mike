/**
 * Word-chat streaming boundary for the task pane.
 *
 * Passes documentContext through, surfaces answer deltas plus model-triggered
 * document-read lifecycle frames, throws on a pre-`[DONE]` `error` frame, and
 * rejects a response that ends without a terminal `[DONE]`. Framing rules live
 * in the local HTTP client's readSSE.
 */
import { streamWordChat, readSSE } from "./mikeApi";
import { MikeApiError, parseApiErrorBody } from "./client";
import { UserVisibleError } from "@mike/user-error";
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

export async function streamAssistant(
  params: {
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
    onMetadata?: (metadata: {
      chatId?: string;
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
  if (!res.ok) {
    // The chat endpoint answers with the same error envelope as the rest of
    // the API, so it is parsed the same way: status/code/request id for
    // classification, and never the raw body on screen.
    const body = await res.text().catch(() => "");
    const parsed = parseApiErrorBody({
      status: res.status,
      body,
      requestId: res.headers.get("x-request-id"),
    });
    throw new MikeApiError({
      status: res.status,
      code: parsed.code,
      requestId: parsed.requestId,
      message: parsed.message,
    });
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
        const assistantMessageId =
          typeof d.assistantMessageId === "string"
            ? d.assistantMessageId
            : undefined;
        if (chatId || assistantMessageId) {
          params.onMetadata?.({ chatId, assistantMessageId });
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
    { signal: params.signal },
  );
  // The backend writes its terminal error frame for the user (see
  // ASSISTANT_ERROR_MESSAGE), so that text is safe to show verbatim — and it
  // is more specific than anything this layer could guess.
  if (streamError) {
    throw new UserVisibleError(streamError, { kind: "server", retryable: true });
  }
  if (!result.done && !params.signal?.aborted) {
    throw new Error("Chat stream ended before the completion marker.");
  }
}
