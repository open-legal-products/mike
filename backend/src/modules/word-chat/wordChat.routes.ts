// HTTP layer for the word-chat module — the Word task pane's chat surface.
//
// Route handlers parse params/query/body, call the wordChat.service functions,
// and map their typed results onto status codes and JSON. The SSE streaming
// loop for POST /word-chat (header flush, runLLMStream, the client-tool
// adapter, abort handling, assistant-message persistence) stays here — its
// ordering is delicate; the pre-stream preparation and the post-stream
// chat-activity write live in wordChat.service.ts.

import { randomUUID } from "node:crypto";
import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import {
  AssistantStreamError,
  ASSISTANT_ERROR_MESSAGE,
  buildCancelledAssistantMessage,
  extractCitations,
  isAbortError,
  parseChatMessages,
  parseOptionalChatId,
  parseOptionalDocumentContext,
  parseOptionalModel,
  parseOptionalReasoning,
  createReservedAssistantMessageUpdater,
  createWordClientToolsAdapter,
  openAssistantSse,
  reserveAssistantMessage,
  runLLMStream,
  stripTransientAssistantEvents,
  submitClientToolResult,
} from "../../lib/chat";
import { enqueueChatTurnAudit } from "../../lib/audit";
import {
  persistWordDocumentEdits,
  WORD_EDIT_FORMATS,
  type WordEditApplyMode,
} from "../../lib/chat/wordDocumentEdits";
import {
  getWordChatWithMessages,
  listWordChats,
  prepareWordChatStream,
  recordWordChatActivity,
  saveProposedWordEdit,
  updateWordChatModel,
  updateWordChatReasoning,
  updateWordEditOutcome,
  type ProposedWordEdit,
} from "./wordChat.service";

export const wordChatRouter = Router();

type WordChatStorageMode = "cloud" | "local";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseDocumentId(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    return { ok: false, detail: "document_id must be a UUID" };
  }
  return { ok: true, value };
}

function parseDocumentName(
  value: unknown,
): { ok: true; value: string } | { ok: false; detail: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: "Word document" };
  }
  if (typeof value !== "string" || !value.trim()) {
    return {
      ok: false,
      detail: "document_name must be a non-empty string",
    };
  }
  const documentName = value.trim();
  if (documentName.length > 255) {
    return {
      ok: false,
      detail: "document_name must be at most 255 characters",
    };
  }
  return { ok: true, value: documentName };
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function parseStorageMode(
  value: unknown,
): { ok: true; value: WordChatStorageMode } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "cloud") {
    return { ok: true, value: "cloud" };
  }
  if (value === "local") return { ok: true, value: "local" };
  return { ok: false, detail: 'storage must be "cloud" or "local"' };
}

function parseEditApplyMode(
  value: unknown,
): { ok: true; value: WordEditApplyMode } | { ok: false; detail: string } {
  if (value === undefined || value === null || value === "approval") {
    return { ok: true, value: "approval" };
  }
  if (value === "direct") return { ok: true, value: "direct" };
  return {
    ok: false,
    detail: 'edit_apply_mode must be "direct" or "approval"',
  };
}

function parseBlockIndex(
  value: string,
): { ok: true; value: number } | { ok: false; detail: string } {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return {
      ok: false,
      detail: "blockIndex must be a non-negative integer",
    };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000) {
    return { ok: false, detail: "blockIndex is out of range" };
  }
  return { ok: true, value: parsed };
}

function parseProposedWordEdit(
  value: unknown,
): { ok: true; value: ProposedWordEdit } | { ok: false; detail: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, detail: "edit body is required" };
  }
  const body = value as Record<string, unknown>;
  const original =
    typeof body.original_text === "string" ? body.original_text : "";
  if (!original.trim()) {
    return { ok: false, detail: "original_text is required" };
  }
  if (original.length > 200) {
    return {
      ok: false,
      detail: "original_text must be at most 200 characters",
    };
  }
  const replacement =
    typeof body.replacement_text === "string" ? body.replacement_text : "";
  if (replacement.length > 200_000) {
    return { ok: false, detail: "replacement_text is too long" };
  }
  const formats = Array.isArray(body.formats)
    ? body.formats.filter(
        (entry): entry is string =>
          typeof entry === "string" && WORD_EDIT_FORMATS.has(entry),
      )
    : [];
  if (Array.isArray(body.formats) && formats.length !== body.formats.length) {
    return { ok: false, detail: "formats contains an unsupported value" };
  }
  const parsedMode = parseEditApplyMode(body.apply_mode);
  if (!parsedMode.ok) return parsedMode;
  if (
    body.occurrence !== undefined &&
    body.occurrence !== null &&
    body.occurrence !== "all"
  ) {
    return { ok: false, detail: 'occurrence must be "all" or null' };
  }
  return {
    ok: true,
    value: {
      original_text: original,
      replacement_text: replacement,
      formats,
      occurrence: body.occurrence === "all" ? "all" : null,
      reason:
        typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 10_000)
          : null,
      apply_mode: parsedMode.value,
    },
  };
}

// GET /word-chat?document_id=<embedded document UUID>&limit=10
wordChatRouter.get("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 100)
    : 50;
  const requestedOffset = Number.parseInt(String(req.query.offset ?? "0"), 10);
  const offset = Number.isFinite(requestedOffset)
    ? Math.max(requestedOffset, 0)
    : 0;
  const db = createServerSupabase();
  const result = await listWordChats(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    limit,
    offset,
  });
  if (!result.ok) {
    return void res.status(500).json({ detail: "Failed to load Word chats" });
  }
  res.json(result.chats);
});

// GET /word-chat/:chatId?document_id=<embedded document UUID>
wordChatRouter.get("/:chatId", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  if (!isUuid(req.params.chatId)) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const db = createServerSupabase();
  const result = await getWordChatWithMessages(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    chatId: req.params.chatId,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    return void res.status(500).json({ detail: "Failed to load Word chat" });
  }
  res.json({ chat: result.chat, messages: result.messages });
});

// PATCH /word-chat/:chatId/model?document_id=<embedded document UUID>
// Selection-time persistence for an existing cloud Word chat.
wordChatRouter.patch("/:chatId/model", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  if (!isUuid(req.params.chatId)) {
    return void res.status(404).json({ detail: "Chat not found" });
  }
  const parsedModel = parseOptionalModel(req.body?.model);
  if (!parsedModel.ok || !parsedModel.value) {
    return void res.status(400).json({
      detail: parsedModel.ok ? "model is required" : parsedModel.detail,
    });
  }

  const db = createServerSupabase();
  const result = await updateWordChatModel(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    chatId: req.params.chatId,
    requestedModel: parsedModel.value,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    if (result.kind === "model") {
      return void res.status(result.status).json({
        code: result.code,
        detail: result.detail,
      });
    }
    return void res.status(500).json({ detail: "Failed to save chat model" });
  }
  res.json({ id: req.params.chatId, model: result.model });
});

// PATCH /word-chat/:chatId/reasoning?document_id=<embedded document UUID>
wordChatRouter.patch("/:chatId/reasoning", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const parsedDocumentId = parseDocumentId(req.query.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const parsedReasoning = parseOptionalReasoning(req.body?.reasoningLevel);
  if (
    !isUuid(req.params.chatId) ||
    !parsedReasoning.ok ||
    !parsedReasoning.value
  ) {
    return void res.status(400).json({
      detail: parsedReasoning.ok
        ? "reasoningLevel is required"
        : parsedReasoning.detail,
    });
  }
  const db = createServerSupabase();
  const result = await updateWordChatReasoning(db, {
    userId,
    clientDocumentId: parsedDocumentId.value,
    chatId: req.params.chatId,
    reasoningLevel: parsedReasoning.value,
  });
  if (!result.ok) {
    if (result.kind === "not_found") {
      return void res.status(404).json({ detail: "Chat not found" });
    }
    return void res.status(500).json({ detail: "Failed to save reasoning" });
  }
  res.json({
    id: req.params.chatId,
    reasoning_level: parsedReasoning.value,
  });
});

// PUT /word-chat/messages/:messageId/edits/:blockIndex
// Idempotently creates the canonical edit row as soon as a streamed edit
// block seals. The final assistant-message save later replaces the raw tags
// with a lightweight reference to the same row.
wordChatRouter.put(
  "/messages/:messageId/edits/:blockIndex",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    if (!isUuid(req.params.messageId)) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const parsedBlockIndex = parseBlockIndex(req.params.blockIndex);
    if (!parsedBlockIndex.ok) {
      return void res.status(400).json({ detail: parsedBlockIndex.detail });
    }
    const parsedEdit = parseProposedWordEdit(req.body);
    if (!parsedEdit.ok) {
      return void res.status(400).json({ detail: parsedEdit.detail });
    }
    const db = createServerSupabase();
    const result = await saveProposedWordEdit(db, {
      userId,
      clientDocumentId: parsedDocumentId.value,
      messageId: req.params.messageId,
      blockIndex: parsedBlockIndex.value,
      edit: parsedEdit.value,
    });
    if (!result.ok) {
      if (result.kind === "not_found") {
        return void res.status(404).json({ detail: "Message not found" });
      }
      return void res.status(500).json({ detail: "Failed to save Word edit" });
    }
    res.json(result.edit);
  },
);

// PATCH /word-chat/messages/:messageId/edits/:blockIndex
// Stores durable apply and accept/reject outcomes without rewriting the
// assistant message JSON.
wordChatRouter.patch(
  "/messages/:messageId/edits/:blockIndex",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const parsedDocumentId = parseDocumentId(req.query.document_id);
    if (!parsedDocumentId.ok) {
      return void res.status(400).json({ detail: parsedDocumentId.detail });
    }
    if (!isUuid(req.params.messageId)) {
      return void res.status(404).json({ detail: "Message not found" });
    }
    const parsedBlockIndex = parseBlockIndex(req.params.blockIndex);
    if (!parsedBlockIndex.ok) {
      return void res.status(400).json({ detail: parsedBlockIndex.detail });
    }
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.apply_status !== undefined) {
      if (
        body.apply_status !== "proposed" &&
        body.apply_status !== "applied" &&
        body.apply_status !== "unmanaged" &&
        body.apply_status !== "failed"
      ) {
        return void res.status(400).json({ detail: "Invalid apply_status" });
      }
      patch.apply_status = body.apply_status;
      if (body.apply_status === "applied") {
        patch.applied_at = new Date().toISOString();
      }
    }
    if (body.resolution_status !== undefined) {
      if (
        body.resolution_status !== "accepted" &&
        body.resolution_status !== "rejected"
      ) {
        return void res
          .status(400)
          .json({ detail: "Invalid resolution_status" });
      }
      patch.resolution_status = body.resolution_status;
      patch.apply_status = "applied";
      patch.resolved_at = new Date().toISOString();
    }
    for (const field of [
      "matched_occurrences",
      "applied_occurrences",
    ] as const) {
      if (body[field] === undefined) continue;
      if (
        typeof body[field] !== "number" ||
        !Number.isSafeInteger(body[field]) ||
        body[field] < 0
      ) {
        return void res.status(400).json({ detail: `Invalid ${field}` });
      }
      patch[field] = body[field];
    }
    for (const field of ["error_code", "error_message"] as const) {
      if (body[field] === undefined) continue;
      if (body[field] !== null && typeof body[field] !== "string") {
        return void res.status(400).json({ detail: `Invalid ${field}` });
      }
      patch[field] =
        typeof body[field] === "string" ? body[field].slice(0, 10_000) : null;
    }
    if (Object.keys(patch).length === 1) {
      return void res.status(400).json({ detail: "No edit fields supplied" });
    }
    const db = createServerSupabase();
    const result = await updateWordEditOutcome(db, {
      userId,
      clientDocumentId: parsedDocumentId.value,
      messageId: req.params.messageId,
      blockIndex: parsedBlockIndex.value,
      patch,
    });
    if (!result.ok) {
      if (result.kind === "message_not_found") {
        return void res.status(404).json({ detail: "Message not found" });
      }
      if (result.kind === "edit_not_found") {
        return void res.status(404).json({ detail: "Edit not found" });
      }
      return void res
        .status(500)
        .json({ detail: "Failed to update Word edit" });
    }
    res.json(result.edit);
  },
);

// POST /word-chat/tool-result — the task pane's return channel for a
// client-executed tool call. The SSE stream carries a `client_tool_call`
// frame down to the pane; the pane executes it with Office.js and posts the
// outcome here, which resolves the tool loop awaiting inside POST /word-chat.
wordChatRouter.post("/tool-result", requireAuth, (req, res) => {
  const userId = res.locals.userId as string;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};
  if (typeof body.tool_call_id !== "string" || !isUuid(body.tool_call_id)) {
    return void res.status(400).json({ detail: "tool_call_id must be a UUID" });
  }
  // `result` is opaque here; the awaiting adapter normalizes it. Delivery
  // fails for expired, unknown, or foreign ids — all three answer the same
  // 404 so the endpoint cannot be probed for live call ids.
  const delivered = submitClientToolResult(
    body.tool_call_id,
    userId,
    body.result,
  );
  if (!delivered) {
    return void res
      .status(404)
      .json({ detail: "Unknown or expired tool call" });
  }
  res.status(204).end();
});

// POST /word-chat — Word-specific streaming endpoint.
wordChatRouter.post("/", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const userEmail = res.locals.userEmail as string | undefined;
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const parsedMessages = parseChatMessages(body.messages);
  if (!parsedMessages.ok) {
    return void res.status(400).json({ detail: parsedMessages.detail });
  }
  const parsedChatId = parseOptionalChatId(body.chat_id);
  if (!parsedChatId.ok) {
    return void res.status(400).json({ detail: parsedChatId.detail });
  }
  if (parsedChatId.value && !isUuid(parsedChatId.value)) {
    return void res.status(400).json({ detail: "chat_id must be a UUID" });
  }
  const parsedModel = parseOptionalModel(body.model);
  if (!parsedModel.ok) {
    return void res.status(400).json({ detail: parsedModel.detail });
  }
  const parsedReasoning = parseOptionalReasoning(body.reasoning);
  if (!parsedReasoning.ok) {
    return void res.status(400).json({ detail: parsedReasoning.detail });
  }
  const parsedDocumentContext = parseOptionalDocumentContext(
    body.document_context,
  );
  if (!parsedDocumentContext.ok) {
    return void res.status(400).json({ detail: parsedDocumentContext.detail });
  }
  const parsedDocumentId = parseDocumentId(body.document_id);
  if (!parsedDocumentId.ok) {
    return void res.status(400).json({ detail: parsedDocumentId.detail });
  }
  const parsedDocumentName = parseDocumentName(body.document_name);
  if (!parsedDocumentName.ok) {
    return void res.status(400).json({ detail: parsedDocumentName.detail });
  }
  const parsedStorage = parseStorageMode(body.storage);
  if (!parsedStorage.ok) {
    return void res.status(400).json({ detail: parsedStorage.detail });
  }
  const parsedEditApplyMode = parseEditApplyMode(body.edit_apply_mode);
  if (!parsedEditApplyMode.ok) {
    return void res.status(400).json({ detail: parsedEditApplyMode.detail });
  }
  // Capability flag from the task pane. Only a pane that declares it can
  // answer client_tool_call frames; older panes keep the streamed <EDITS>
  // protocol so they are never handed tool calls they would ignore.
  const clientToolsEnabled = body.client_tools === true;

  const activeDocumentName = parsedDocumentName.value;
  const persistChat = parsedStorage.value === "cloud";
  const editApplyMode = parsedEditApplyMode.value;
  const db = createServerSupabase();

  const prep = await prepareWordChatStream(db, {
    userId,
    userEmail,
    messages: parsedMessages.value,
    chatId: parsedChatId.value ?? null,
    clientDocumentId: parsedDocumentId.value,
    activeDocumentName,
    documentContext: parsedDocumentContext.documentContext,
    persistChat,
    clientToolsEnabled,
    requestedModel: parsedModel.value,
    requestedReasoning: parsedReasoning.value,
  });
  if (!prep.ok) {
    return void res.status(prep.status).json({
      ...(prep.code ? { code: prep.code } : {}),
      detail: prep.detail,
    });
  }

  const {
    chatId,
    lastUserContent,
    docIndex,
    docStore,
    apiMessages,
    workflowStore,
    apiKeys,
    selectedModel,
    selectedReasoningLevel,
    nonce,
  } = prep.prepared;
  let chatTitle = prep.prepared.chatTitle;
  const assistantMessageId = randomUUID();

  if (persistChat) {
    const error = await reserveAssistantMessage({
      db,
      table: "word_chat_messages",
      id: assistantMessageId,
      chatId,
    });
    if (error) {
      console.error("[word-chat] failed to reserve assistant message", error);
      return void res
        .status(500)
        .json({ detail: "Failed to start Word assistant response" });
    }
  }

  const stream = openAssistantSse(res);
  const write = stream.write;
  const updateAssistantMessage = createReservedAssistantMessageUpdater({
    db,
    table: "word_chat_messages",
    id: assistantMessageId,
    chatId,
    enabled: persistChat,
  });
  const normalizeAssistantEvents = async (
    events: unknown[],
  ): Promise<unknown[]> => {
    if (!persistChat) return events;
    const normalized = await persistWordDocumentEdits({
      db,
      messageId: assistantMessageId,
      events,
      applyMode: editApplyMode,
    });
    return normalized.events;
  };
  const updateChatActivity = async (): Promise<void> => {
    // Mirror the title the service just persisted back into the local
    // variable so the audit enqueue below names the chat, the way chat.ts
    // does. Without this the first turn of every Word chat would audit under
    // a null title.
    const nextTitle = await recordWordChatActivity(db, {
      persistChat,
      chatId,
      userId,
      chatTitle,
      lastUserContent,
    });
    if (nextTitle) chatTitle = nextTitle;
  };

  try {
    write(
      `data: ${JSON.stringify({
        type: "chat_id",
        chatId,
        assistantMessageId,
      })}\n\n`,
    );
    const { events, citations } = await runLLMStream({
      apiMessages,
      docStore,
      docIndex,
      userId,
      db,
      write,
      workflowStore,
      // CourtListener is intentionally unavailable in document-scoped Word
      // chats. Legal research remains a web-assistant capability.
      includeResearchTools: false,
      includeAskInputs: false,
      ...(clientToolsEnabled
        ? {
            clientTools: createWordClientToolsAdapter({
              userId,
              write,
              signal: stream.signal,
              nonce,
            }),
            // The edit flow is built around retry round-trips (propose →
            // fail → read_active_document → retry), each costing one
            // iteration; the default budget of 10 can end the loop before
            // the model gets to write its summary.
            maxIterations: 16,
          }
        : {}),
      model: selectedModel,
      reasoning: selectedReasoningLevel,
      apiKeys,
      signal: stream.signal,
      nonce,
      emitDone: false,
    });
    const persistedEvents = await normalizeAssistantEvents(
      stripTransientAssistantEvents(events),
    );
    const saveError = await updateAssistantMessage(
      persistedEvents.length ? persistedEvents : null,
      citations.length ? citations : null,
    );
    await updateChatActivity();
    if (saveError) {
      console.error("[word-chat] failed to save assistant response", saveError);
      write(
        `data: ${JSON.stringify({
          type: "error",
          message:
            "The response was generated but could not be saved. Keep this document open and review its tracked changes in Word.",
        })}\n\n`,
      );
      write("data: [DONE]\n\n");
      return;
    }
    // Word turns used to be audited nowhere, unlike the chat and project-chat
    // modules. chatId/projectId stay null because a Word chat lives in
    // word_chats — neither chats.id nor projects.id is a legal value for those
    // columns — so `surface: "word"` is what makes these rows identifiable in
    // the history feed. Placement mirrors chat.routes.ts: after the response is
    // durable, immediately before [DONE].
    void enqueueChatTurnAudit(
      db,
      {
        userId,
        userEmail,
        chatId: null,
        projectId: null,
        surface: "word",
        // Never the raw prompt: storage:"local" is the user asking that this
        // conversation NOT be kept server-side, so the audit row records that
        // a Word turn happened and which document it touched, not what was
        // said. In cloud mode chatTitle is the prompt-derived title the
        // server already stores, so nothing is lost there.
        title: chatTitle ?? activeDocumentName ?? null,
        model: selectedModel,
      },
      // Word edits are applied client-side in the document, not persisted as
      // doc_created/doc_edited artifacts, so there is nothing here for the
      // artifact fan-out to map — only the chat.message row.
      [],
    );
    write("data: [DONE]\n\n");
  } catch (error) {
    if (isAbortError(error)) {
      void enqueueChatTurnAudit(
        db,
        {
          userId,
          userEmail,
          chatId: null,
          projectId: null,
          surface: "word",
          title: chatTitle ?? activeDocumentName ?? null,
          model: selectedModel,
          status: "cancelled",
        },
        null,
      );
      if (error instanceof AssistantStreamError) {
        const partial = buildCancelledAssistantMessage({
          fullText: error.fullText,
          events: error.events,
          buildCitations: (fullText) =>
            extractCitations(fullText, docIndex, docStore),
        });
        const partialEvents = await normalizeAssistantEvents(partial.events);
        const saveError = await updateAssistantMessage(
          partialEvents.length ? partialEvents : null,
          partial.citations.length ? partial.citations : null,
        );
        if (saveError) {
          console.error("[word-chat] failed to save aborted stream", saveError);
        }
      }
      await updateChatActivity();
      return;
    }
    console.error("[word-chat] stream error", error);
    const message = ASSISTANT_ERROR_MESSAGE;
    const errorEvents =
      error instanceof AssistantStreamError
        ? stripTransientAssistantEvents(error.events)
        : [{ type: "error" as const, message }];
    const errorFullText =
      error instanceof AssistantStreamError ? error.fullText : "";
    try {
      const citations = extractCitations(errorFullText, docIndex, docStore);
      const normalizedErrorEvents = await normalizeAssistantEvents(errorEvents);
      const saveError = await updateAssistantMessage(
        normalizedErrorEvents.length ? normalizedErrorEvents : null,
        citations.length ? citations : null,
      );
      if (saveError) {
        console.error("[word-chat] failed to save stream error", saveError);
      }
    } catch (saveError) {
      console.error("[word-chat] failed to persist stream error", saveError);
    }
    try {
      write(`data: ${JSON.stringify({ type: "error", message })}\n\n`);
      write("data: [DONE]\n\n");
    } catch {
      // The client disconnected while the error was being handled.
    }
  } finally {
    stream.finish();
  }
});
