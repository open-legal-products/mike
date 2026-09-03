// Business logic + data-access for the word-chat module.
//
// Service layer behind wordChat.routes.ts. Every function takes an explicit
// Supabase client (`db`) plus request-derived primitives, performs the DB work,
// and RETURNS typed results. Nothing here imports express or touches req/res —
// the thin route handlers map these results onto status codes and JSON.
//
// IMPORTANT: the SSE streaming loop for POST /word-chat (header flush,
// runLLMStream, the client-tool adapter, abort handling, assistant-message
// persistence) deliberately stays in the route — its ordering is delicate.
// Only the pre-stream preparation (`prepareWordChatStream`) and the post-stream
// chat-activity write (`recordWordChatActivity`) live here.

import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/supabase";
import {
  ACTIVE_WORD_DOCUMENT_ID,
  buildDocContext,
  buildMessages,
  buildUserPersonalisationPrompt,
  buildWordChatSystemPrompt,
  buildWorkflowStore,
  enrichWithPriorEvents,
  generateSpotlightNonce,
  withoutEmptyAssistantReservations,
  type ChatMessage,
} from "../../lib/chat";
import {
  getUserModelSettings,
  persistLastSelectedChatModel,
  persistLastSelectedReasoningLevel,
} from "../user/user.service";
import {
  resolveEffectiveChatModel,
  resolveEffectiveReasoningLevel,
} from "../../lib/modelSelection";
import type { WordEditApplyMode } from "../../lib/chat/wordDocumentEdits";

type LookupResult<T> =
  { ok: true; value: T | null } | { ok: false; detail: string };

/** The canonical payload of a proposed Word edit, as parsed by the route. */
export type ProposedWordEdit = {
  original_text: string;
  replacement_text: string;
  formats: string[];
  occurrence: "all" | null;
  reason: string | null;
  apply_mode: WordEditApplyMode;
};

// ---------------------------------------------------------------------------
// Internal lookups
// ---------------------------------------------------------------------------

async function getWordDocumentRowId(
  clientDocumentId: string,
  userId: string,
  db: Db,
): Promise<LookupResult<string>> {
  const { data, error } = await db
    .from("word_documents")
    .select("id")
    .eq("user_id", userId)
    .eq("client_document_id", clientDocumentId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: true, value: null };
  return { ok: true, value: data.id as string };
}

async function ensureWordDocumentRow(
  clientDocumentId: string,
  userId: string,
  db: Db,
): Promise<string | null> {
  const { data, error } = await db
    .from("word_documents")
    .upsert(
      {
        user_id: userId,
        client_document_id: clientDocumentId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,client_document_id" },
    )
    .select("id")
    .single();
  if (error || !data) {
    console.error("[word-chat] failed to resolve document", error);
    return null;
  }
  return data.id as string;
}

async function getAccessibleWordChat(
  chatId: string,
  wordDocumentRowId: string,
  userId: string,
  db: Db,
): Promise<LookupResult<Record<string, unknown>>> {
  const { data, error } = await db
    .from("word_chats")
    .select("*")
    .eq("id", chatId)
    .eq("word_document_id", wordDocumentRowId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: true, value: null };
  return {
    ok: true,
    value: { ...(data as Record<string, unknown>), project_id: null },
  };
}

async function getAccessibleWordMessage(args: {
  messageId: string;
  clientDocumentId: string;
  userId: string;
  db: Db;
}): Promise<LookupResult<Record<string, unknown>>> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    args.db,
  );
  if (!documentLookup.ok) return documentLookup;
  if (!documentLookup.value) return { ok: true, value: null };
  const { data: message, error } = await args.db
    .from("word_chat_messages")
    .select("id, chat_id, role")
    .eq("id", args.messageId)
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!message || message.role !== "assistant") {
    return { ok: true, value: null };
  }
  const chatLookup = await getAccessibleWordChat(
    message.chat_id as string,
    documentLookup.value,
    args.userId,
    args.db,
  );
  if (!chatLookup.ok || !chatLookup.value) return chatLookup;
  return { ok: true, value: message as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Non-streaming endpoints
// ---------------------------------------------------------------------------

// GET /word-chat
export async function listWordChats(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    limit: number;
    offset: number;
  },
): Promise<
  { ok: true; chats: Record<string, unknown>[] } | { ok: false; kind: "error" }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to load document chats",
      documentLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  const wordDocumentRowId = documentLookup.value;
  // No stored document row yet means this pane has never persisted a chat.
  if (!wordDocumentRowId) return { ok: true, chats: [] };

  let query = db
    .from("word_chats")
    .select(
      "id, user_id, title, model, reasoning_level, created_at, updated_at",
    )
    .eq("word_document_id", wordDocumentRowId)
    .eq("user_id", args.userId)
    .order("updated_at", { ascending: false });
  query =
    args.offset > 0
      ? query.range(args.offset, args.offset + args.limit - 1)
      : query.limit(args.limit);
  const { data, error } = await query;
  if (error) {
    console.error("[word-chat] failed to list chats", error);
    return { ok: false, kind: "error" };
  }
  return {
    ok: true,
    chats: (data ?? []).map((chat) => ({ ...chat, project_id: null })),
  };
}

// GET /word-chat/:chatId
export async function getWordChatWithMessages(
  db: Db,
  args: { userId: string; clientDocumentId: string; chatId: string },
): Promise<
  | {
      ok: true;
      chat: Record<string, unknown>;
      messages: Record<string, unknown>[];
    }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error" }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to resolve chat document",
      documentLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  const wordDocumentRowId = documentLookup.value;
  if (!wordDocumentRowId) return { ok: false, kind: "not_found" };
  const chatLookup = await getAccessibleWordChat(
    args.chatId,
    wordDocumentRowId,
    args.userId,
    db,
  );
  if (!chatLookup.ok) {
    console.error("[word-chat] failed to load chat", chatLookup.detail);
    return { ok: false, kind: "error" };
  }
  const chat = chatLookup.value;
  if (!chat) return { ok: false, kind: "not_found" };

  const { data: messages, error } = await db
    .from("word_chat_messages")
    .select("*")
    .eq("chat_id", args.chatId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[word-chat] failed to load messages", error);
    return { ok: false, kind: "error" };
  }
  const visibleMessages = withoutEmptyAssistantReservations(messages ?? []);
  const assistantMessageIds = visibleMessages.flatMap((message) =>
    message.role === "assistant" && typeof message.id === "string"
      ? [message.id]
      : [],
  );
  const editsByMessage = new Map<string, Record<string, unknown>[]>();
  if (assistantMessageIds.length > 0) {
    const { data: edits, error: editsError } = await db
      .from("word_document_edits")
      .select("*")
      .in("word_chat_message_id", assistantMessageIds)
      .order("block_index", { ascending: true });
    if (editsError) {
      console.error("[word-chat] failed to load document edits", editsError);
      return { ok: false, kind: "error" };
    }
    for (const edit of (edits ?? []) as Record<string, unknown>[]) {
      const messageId = edit.word_chat_message_id;
      if (typeof messageId !== "string") continue;
      const current = editsByMessage.get(messageId) ?? [];
      current.push(edit);
      editsByMessage.set(messageId, current);
    }
  }
  return {
    ok: true,
    chat,
    messages: visibleMessages.map((message) => ({
      ...message,
      ...(typeof message.id === "string" && editsByMessage.has(message.id)
        ? { edits: editsByMessage.get(message.id) }
        : {}),
    })),
  };
}

// PATCH /word-chat/:chatId/model — selection-time persistence for an existing
// cloud Word chat.
export async function updateWordChatModel(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    chatId: string;
    requestedModel: string;
  },
): Promise<
  | { ok: true; model: string }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error" }
  | { ok: false; kind: "model"; status: number; code: string; detail: string }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok) {
    console.error(
      "[word-chat] failed to resolve model-selection document",
      documentLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  if (!documentLookup.value) return { ok: false, kind: "not_found" };
  const chatLookup = await getAccessibleWordChat(
    args.chatId,
    documentLookup.value,
    args.userId,
    db,
  );
  if (!chatLookup.ok) {
    console.error(
      "[word-chat] failed to load model-selection chat",
      chatLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  if (!chatLookup.value) return { ok: false, kind: "not_found" };

  const settings = await getUserModelSettings(args.userId, db);
  const resolution = await resolveEffectiveChatModel({
    requested: args.requestedModel,
    chatModel: chatLookup.value.model as string | null,
    lastSelectedModel: settings.last_selected_chat_model,
    apiKeys: settings.api_keys,
    userId: args.userId,
    db,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      kind: "model",
      status: resolution.status,
      code: resolution.code,
      detail: resolution.detail,
    };
  }

  const { error } = await db
    .from("word_chats")
    .update({
      model: resolution.model,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.chatId)
    .eq("user_id", args.userId);
  if (error) {
    console.error("[word-chat] failed to save selected chat model", error);
    return { ok: false, kind: "error" };
  }
  const profileError = await persistLastSelectedChatModel(
    args.userId,
    resolution.model,
    db,
  );
  if (profileError) {
    console.error(
      "[word-chat] failed to save last-selected model",
      profileError,
    );
    return { ok: false, kind: "error" };
  }
  return { ok: true, model: resolution.model };
}

// PATCH /word-chat/:chatId/reasoning
export async function updateWordChatReasoning(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    chatId: string;
    reasoningLevel: ReturnType<typeof resolveEffectiveReasoningLevel>;
  },
): Promise<
  { ok: true } | { ok: false; kind: "not_found" } | { ok: false; kind: "error" }
> {
  const documentLookup = await getWordDocumentRowId(
    args.clientDocumentId,
    args.userId,
    db,
  );
  if (!documentLookup.ok || !documentLookup.value) {
    return { ok: false, kind: "not_found" };
  }
  const chatLookup = await getAccessibleWordChat(
    args.chatId,
    documentLookup.value,
    args.userId,
    db,
  );
  if (!chatLookup.ok || !chatLookup.value) {
    return { ok: false, kind: "not_found" };
  }
  const { error } = await db
    .from("word_chats")
    .update({
      reasoning_level: args.reasoningLevel,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.chatId)
    .eq("user_id", args.userId);
  if (error) return { ok: false, kind: "error" };
  const profileError = await persistLastSelectedReasoningLevel(
    args.userId,
    args.reasoningLevel,
    db,
  );
  if (profileError) return { ok: false, kind: "error" };
  return { ok: true };
}

// PUT /word-chat/messages/:messageId/edits/:blockIndex
//
// Idempotently creates the canonical edit row as soon as a streamed edit block
// seals. The final assistant-message save later replaces the raw tags with a
// lightweight reference to the same row.
export async function saveProposedWordEdit(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    messageId: string;
    blockIndex: number;
    edit: ProposedWordEdit;
  },
): Promise<
  | { ok: true; edit: Record<string, unknown> }
  | { ok: false; kind: "not_found" }
  | { ok: false; kind: "error" }
> {
  const messageLookup = await getAccessibleWordMessage({
    messageId: args.messageId,
    clientDocumentId: args.clientDocumentId,
    userId: args.userId,
    db,
  });
  if (!messageLookup.ok) {
    console.error(
      "[word-chat] failed to validate edit message",
      messageLookup.detail,
    );
    return { ok: false, kind: "error" };
  }
  if (!messageLookup.value) return { ok: false, kind: "not_found" };
  const { error: insertError } = await db
    .from("word_document_edits")
    .upsert(
      {
        word_chat_message_id: args.messageId,
        block_index: args.blockIndex,
        ...args.edit,
      },
      {
        onConflict: "word_chat_message_id,block_index",
        ignoreDuplicates: true,
      },
    )
    .select("id");
  if (insertError) {
    console.error("[word-chat] failed to save edit", insertError);
    return { ok: false, kind: "error" };
  }
  // The first sealed payload is canonical. A retry returns that row without
  // rewriting its text, apply mode, or any lifecycle state already recorded.
  const { data, error } = await db
    .from("word_document_edits")
    .select("*")
    .eq("word_chat_message_id", args.messageId)
    .eq("block_index", args.blockIndex)
    .maybeSingle();
  if (error || !data) {
    console.error("[word-chat] failed to load edit", error);
    return { ok: false, kind: "error" };
  }
  return { ok: true, edit: data as Record<string, unknown> };
}

// PATCH /word-chat/messages/:messageId/edits/:blockIndex
//
// Stores durable apply and accept/reject outcomes without rewriting the
// assistant message JSON. The patch itself is validated by the route.
export async function updateWordEditOutcome(
  db: Db,
  args: {
    userId: string;
    clientDocumentId: string;
    messageId: string;
    blockIndex: number;
    patch: Record<string, unknown>;
  },
): Promise<
  | { ok: true; edit: Record<string, unknown> }
  | { ok: false; kind: "message_not_found" }
  | { ok: false; kind: "edit_not_found" }
  | { ok: false; kind: "error" }
> {
  const messageLookup = await getAccessibleWordMessage({
    messageId: args.messageId,
    clientDocumentId: args.clientDocumentId,
    userId: args.userId,
    db,
  });
  if (!messageLookup.ok) return { ok: false, kind: "error" };
  if (!messageLookup.value) return { ok: false, kind: "message_not_found" };
  const { data, error } = await db
    .from("word_document_edits")
    .update(args.patch)
    .eq("word_chat_message_id", args.messageId)
    .eq("block_index", args.blockIndex)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("[word-chat] failed to update edit", error);
    return { ok: false, kind: "error" };
  }
  if (!data) return { ok: false, kind: "edit_not_found" };
  return { ok: true, edit: data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Pre-stream preparation for POST /word-chat (streaming)
// ---------------------------------------------------------------------------
//
// The DB work that precedes the SSE stream: resolving or creating the Word
// document row and its chat, persisting the user message, building doc context
// + messages, and assembling the workflow store. It RETURNS the prepared data;
// the route owns the assistant-message reservation, the header flush, the
// runLLMStream loop, and the persistence that follows it.

export type PreparedWordChatStream = {
  chatId: string;
  chatTitle: string | null;
  lastUserContent: string | null | undefined;
  docIndex: Awaited<ReturnType<typeof buildDocContext>>["docIndex"];
  docStore: Awaited<ReturnType<typeof buildDocContext>>["docStore"];
  apiMessages: ReturnType<typeof buildMessages>;
  workflowStore: Awaited<ReturnType<typeof buildWorkflowStore>>;
  apiKeys: Awaited<ReturnType<typeof getUserModelSettings>>["api_keys"];
  selectedModel: string;
  selectedReasoningLevel: ReturnType<typeof resolveEffectiveReasoningLevel>;
  nonce: ReturnType<typeof generateSpotlightNonce>;
};

export async function prepareWordChatStream(
  db: Db,
  args: {
    userId: string;
    userEmail: string | undefined;
    messages: ChatMessage[];
    chatId: string | null;
    clientDocumentId: string;
    activeDocumentName: string;
    // Trimmed `document_context` from the task pane: the live document as
    // structure-annotated markdown, or undefined when the pane sent none.
    documentContext: string | undefined;
    // `storage: "cloud"` — a local-only chat performs no persistence at all.
    persistChat: boolean;
    // Capability flag from the task pane. Only a pane that declares it can
    // answer client_tool_call frames; older panes keep the streamed <EDITS>
    // protocol so they are never handed tool calls they would ignore.
    clientToolsEnabled: boolean;
    requestedModel: string | null | undefined;
    requestedReasoning:
      ReturnType<typeof resolveEffectiveReasoningLevel> | undefined;
  },
): Promise<
  | { ok: true; prepared: PreparedWordChatStream }
  | { ok: false; status: number; code?: string; detail: string }
> {
  const {
    userId,
    userEmail,
    messages,
    clientDocumentId,
    activeDocumentName,
    persistChat,
  } = args;
  let chatId = args.chatId;
  let chatTitle: string | null = null;
  let chatModel: string | null = null;
  let chatReasoningLevel: string | null = null;
  let wordDocumentRowId: string | null = null;

  if (persistChat) {
    wordDocumentRowId = await ensureWordDocumentRow(
      clientDocumentId,
      userId,
      db,
    );
    if (!wordDocumentRowId) {
      return {
        ok: false,
        status: 500,
        detail: "Failed to initialize Word chat storage",
      };
    }
  }

  if (chatId && persistChat) {
    const existingLookup = await getAccessibleWordChat(
      chatId,
      wordDocumentRowId as string,
      userId,
      db,
    );
    if (!existingLookup.ok) {
      console.error("[word-chat] failed to resume chat", existingLookup.detail);
      return { ok: false, status: 500, detail: "Failed to resume Word chat" };
    }
    const existing = existingLookup.value;
    if (!existing) {
      return { ok: false, status: 404, detail: "Chat not found" };
    }
    chatTitle = typeof existing.title === "string" ? existing.title : null;
    chatModel = typeof existing.model === "string" ? existing.model : null;
    chatReasoningLevel =
      typeof existing.reasoning_level === "string"
        ? existing.reasoning_level
        : null;
  }

  const modelSettings = await getUserModelSettings(userId, db);
  const modelResolution = await resolveEffectiveChatModel({
    requested: args.requestedModel,
    chatModel,
    lastSelectedModel: modelSettings.last_selected_chat_model,
    apiKeys: modelSettings.api_keys,
    userId,
    db,
  });
  if (!modelResolution.ok) {
    return {
      ok: false,
      status: modelResolution.status,
      code: modelResolution.code,
      detail: modelResolution.detail,
    };
  }
  const selectedModel = modelResolution.model;
  const selectedReasoningLevel = resolveEffectiveReasoningLevel({
    model: selectedModel,
    requested: args.requestedReasoning,
    chatReasoningLevel,
    lastSelectedReasoningLevel: modelSettings.last_selected_reasoning_level,
  });

  if (
    chatId &&
    persistChat &&
    (chatModel !== selectedModel ||
      chatReasoningLevel !== selectedReasoningLevel)
  ) {
    const { error } = await db
      .from("word_chats")
      .update({
        model: selectedModel,
        reasoning_level: selectedReasoningLevel,
      })
      .eq("id", chatId)
      .eq("user_id", userId);
    if (error) {
      return { ok: false, status: 500, detail: "Failed to save chat model" };
    }
  }

  if (!chatId && persistChat) {
    const { data, error } = await db
      .from("word_chats")
      .insert({
        user_id: userId,
        word_document_id: wordDocumentRowId,
        model: selectedModel,
        reasoning_level: selectedReasoningLevel,
      })
      .select("id, title")
      .single();
    if (error || !data) {
      console.error("[word-chat] failed to create chat", error);
      return { ok: false, status: 500, detail: "Failed to create Word chat" };
    }
    chatId = data.id as string;
    chatTitle = (data.title as string | null) ?? null;
  }
  if (!chatId) chatId = randomUUID();

  const lastUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  if (lastUser && persistChat) {
    // Persist only the user's actual message. The Word edit contract is added
    // later as a system prompt and therefore cannot leak into chat history.
    const { error } = await db.from("word_chat_messages").insert({
      chat_id: chatId,
      role: "user",
      content: lastUser.content,
      files: lastUser.files ?? null,
      workflow: lastUser.workflow ?? null,
    });
    if (error) {
      return { ok: false, status: 500, detail: "Failed to save Word message" };
    }
  }

  const { docIndex, docStore } = await buildDocContext(
    messages,
    userId,
    db,
    persistChat ? chatId : null,
    "word_chat_messages",
  );
  const activeDocumentText = args.documentContext;
  if (activeDocumentText !== undefined) {
    docStore.set(ACTIVE_WORD_DOCUMENT_ID, {
      // This is an in-memory identity, never a Supabase storage path.
      storage_path: `inline:word-document:${clientDocumentId}`,
      file_type: "text/markdown",
      filename: activeDocumentName,
      inline_text: activeDocumentText,
    });
  }
  const docAvailability = [
    ...(activeDocumentText !== undefined
      ? [
          {
            doc_id: ACTIVE_WORD_DOCUMENT_ID,
            filename: activeDocumentName,
          },
        ]
      : []),
    ...Object.entries(docIndex).map(([doc_id, info]) => ({
      doc_id,
      filename: info.filename,
    })),
  ];
  const nonce = generateSpotlightNonce();
  const enrichedMessages = await enrichWithPriorEvents(
    messages,
    persistChat ? chatId : null,
    db,
    docIndex,
    nonce,
    "word_chat_messages",
  );
  const { api_keys: configuredApiKeys, personalisation } = modelSettings;
  const apiKeys = { ...configuredApiKeys };
  delete apiKeys.courtlistener;
  const personalisationPrompt = buildUserPersonalisationPrompt(
    personalisation,
    nonce,
  );
  const wordSystemPrompt = [
    buildWordChatSystemPrompt(args.clientToolsEnabled),
    personalisationPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  const apiMessages = buildMessages(
    enrichedMessages,
    docAvailability,
    wordSystemPrompt,
    docIndex,
    false,
    nonce,
    "replace",
  );
  const workflowStore = await buildWorkflowStore(userId, userEmail, db);

  return {
    ok: true,
    prepared: {
      chatId,
      chatTitle,
      lastUserContent: lastUser?.content,
      docIndex,
      docStore,
      apiMessages,
      workflowStore,
      apiKeys,
      selectedModel,
      selectedReasoningLevel,
      nonce,
    },
  };
}

// Post-stream: bump the chat's activity timestamp and, on the first turn,
// title it from the user's prompt.
//
// Returns the title that was just persisted so the caller can mirror it into
// its local `chatTitle`, the way chat.ts does — without this the first turn of
// every Word chat would audit under a null title. Returns null when nothing was
// titled (local-only storage, an already-titled chat, or a failed write).
export async function recordWordChatActivity(
  db: Db,
  args: {
    persistChat: boolean;
    chatId: string;
    userId: string;
    chatTitle: string | null;
    lastUserContent: string | null | undefined;
  },
): Promise<string | null> {
  if (!args.persistChat) return null;
  const nextTitle =
    !args.chatTitle && args.lastUserContent
      ? args.lastUserContent.slice(0, 120)
      : null;
  const update = {
    ...(nextTitle ? { title: nextTitle } : {}),
    updated_at: new Date().toISOString(),
  };
  const { error } = await db
    .from("word_chats")
    .update(update)
    .eq("id", args.chatId)
    .eq("user_id", args.userId);
  if (error) {
    console.error("[word-chat] failed to update chat activity", error);
    return null;
  }
  return nextTitle;
}
