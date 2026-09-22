import type { Chat, Message, WordDocumentEdit } from "../types";
import type { PersistedWordEditPatch } from "./wordChatTypes";
import { notifyWordChatHistoryChanged } from "./wordChatHistoryEvents";

const DATABASE_NAME = "mike-word-addin";
const DATABASE_VERSION = 4;
const CHAT_STORE = "word-chats";
const MESSAGE_STORE = "word-chat-messages";
const EDIT_STORE = "word-document-edits";

interface LocalChatRow extends Chat {
  document_id: string;
  owner_id: string;
  updated_at: string;
  /**
   * The server-owned turn this chat had in flight when the pane last wrote
   * to it. A local chat has no server row, so this is the ONLY record a
   * reopened pane has of an answer that is still being generated; it is
   * cleared when the turn ends, whatever the outcome. A stale value (the
   * server restarted, the retention window passed) simply 404s on resume.
   */
  active_turn_id?: string | null;
}

interface LocalMessageRow extends Message {
  id: string;
  chat_id: string;
  created_at: string;
  /** Append order within the chat; optional for databases created before this field. */
  sequence?: number;
}

interface LocalEditRow extends WordDocumentEdit {
  document_id: string;
  owner_id: string;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error("IndexedDB transaction was aborted."),
      );
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHAT_STORE)) {
        const chats = database.createObjectStore(CHAT_STORE, { keyPath: "id" });
        chats.createIndex("document_id", "document_id", { unique: false });
        chats.createIndex("owner_document", ["owner_id", "document_id"], {
          unique: false,
        });
      } else {
        const chats = request.transaction?.objectStore(CHAT_STORE);
        if (chats && !chats.indexNames.contains("owner_document")) {
          chats.createIndex("owner_document", ["owner_id", "document_id"], {
            unique: false,
          });
        }
      }
      if (!database.objectStoreNames.contains(MESSAGE_STORE)) {
        const messages = database.createObjectStore(MESSAGE_STORE, {
          keyPath: "id",
        });
        messages.createIndex("chat_id", "chat_id", { unique: false });
      }
      if (!database.objectStoreNames.contains(EDIT_STORE)) {
        const edits = database.createObjectStore(EDIT_STORE, { keyPath: "id" });
        edits.createIndex("message_id", "messageId", { unique: false });
        edits.createIndex("owner_document", ["owner_id", "document_id"], {
          unique: false,
        });
      } else {
        const edits = request.transaction?.objectStore(EDIT_STORE);
        if (edits && !edits.indexNames.contains("owner_document")) {
          edits.createIndex("owner_document", ["owner_id", "document_id"], {
            unique: false,
          });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        request.error ?? new Error("Could not open local Word chat storage."),
      );
  });
}

export async function createLocalWordDocumentEdit(args: {
  documentId: string;
  ownerId: string;
  messageId: string;
  blockIndex: number;
  originalText: string;
  replacementText: string;
  formats: string[];
  occurrence?: "all";
  reason?: string;
  applyMode: "direct" | "approval";
}): Promise<WordDocumentEdit> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(EDIT_STORE, "readwrite");
    const edits = transaction.objectStore(EDIT_STORE);
    const id = `${args.messageId}:edit-${args.blockIndex}`;
    const existing = (await requestResult(edits.get(id))) as
      LocalEditRow | undefined;
    if (existing) {
      if (
        existing.document_id !== args.documentId ||
        existing.owner_id !== args.ownerId
      ) {
        transaction.abort();
        throw new Error("Local Word edit is not available for this document.");
      }
      await transactionDone(transaction);
      return existing;
    }
    const row: LocalEditRow = {
      id,
      messageId: args.messageId,
      blockIndex: args.blockIndex,
      originalText: args.originalText,
      replacementText: args.replacementText,
      formats: args.formats,
      ...(args.occurrence ? { occurrence: args.occurrence } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
      applyMode: args.applyMode,
      applyStatus: "proposed",
      document_id: args.documentId,
      owner_id: args.ownerId,
    };
    edits.put(row);
    await transactionDone(transaction);
    return row;
  } finally {
    database.close();
  }
}

export async function updateLocalWordDocumentEdit(args: {
  documentId: string;
  ownerId: string;
  messageId: string;
  blockIndex: number;
  patch: PersistedWordEditPatch;
}): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(EDIT_STORE, "readwrite");
    const edits = transaction.objectStore(EDIT_STORE);
    const id = `${args.messageId}:edit-${args.blockIndex}`;
    const existing = (await requestResult(edits.get(id))) as
      LocalEditRow | undefined;
    if (
      !existing ||
      existing.document_id !== args.documentId ||
      existing.owner_id !== args.ownerId
    ) {
      transaction.abort();
      throw new Error("Local Word edit is not available for this document.");
    }
    edits.put({
      ...existing,
      ...(args.patch.apply_status
        ? { applyStatus: args.patch.apply_status }
        : {}),
      ...(args.patch.resolution_status
        ? {
            resolutionStatus: args.patch.resolution_status,
            applyStatus: "applied" as const,
          }
        : {}),
      ...(args.patch.matched_occurrences !== undefined
        ? { matchedOccurrences: args.patch.matched_occurrences }
        : {}),
      ...(args.patch.applied_occurrences !== undefined
        ? { appliedOccurrences: args.patch.applied_occurrences }
        : {}),
      ...(args.patch.error_code === null
        ? { errorCode: undefined }
        : args.patch.error_code !== undefined
          ? { errorCode: args.patch.error_code }
          : {}),
      ...(args.patch.error_message === null
        ? { errorMessage: undefined }
        : args.patch.error_message !== undefined
          ? { errorMessage: args.patch.error_message }
          : {}),
    } satisfies LocalEditRow);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function saveLocalWordMessage(args: {
  documentId: string;
  ownerId: string;
  chatId: string;
  message: Message;
  title?: string;
  model?: string;
  reasoningLevel?: import("./wordChatTypes").ReasoningLevel;
  /**
   * The turn now running into this chat, or null to clear it. Omitted leaves
   * whatever is stored, so an ordinary message save never disturbs it.
   */
  activeTurnId?: string | null;
}): Promise<void> {
  const messageId = args.message.id;
  if (!messageId) {
    throw new Error("Local messages require a stable ID.");
  }
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [CHAT_STORE, MESSAGE_STORE],
      "readwrite",
    );
    const chats = transaction.objectStore(CHAT_STORE);
    const messages = transaction.objectStore(MESSAGE_STORE);
    const now = new Date().toISOString();
    const existing = (await requestResult(chats.get(args.chatId))) as
      LocalChatRow | undefined;
    const existingMessage = (await requestResult(messages.get(messageId))) as
      LocalMessageRow | undefined;
    if (existingMessage && existingMessage.chat_id !== args.chatId) {
      transaction.abort();
      throw new Error("Local message ID is already used by another chat.");
    }
    const chatMessages = (await requestResult(
      messages.index("chat_id").getAll(IDBKeyRange.only(args.chatId)),
    )) as LocalMessageRow[];
    const nextSequence =
      chatMessages.reduce(
        (highest, message, index) =>
          Math.max(highest, message.sequence ?? index),
        -1,
      ) + 1;
    chats.put({
      id: args.chatId,
      document_id: args.documentId,
      owner_id: args.ownerId,
      project_id: null,
      user_id: "local",
      title: existing?.title ?? args.title ?? null,
      model: args.model ?? existing?.model ?? null,
      reasoning_level:
        args.reasoningLevel ?? existing?.reasoning_level ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      active_turn_id:
        args.activeTurnId !== undefined
          ? args.activeTurnId
          : (existing?.active_turn_id ?? null),
    } satisfies LocalChatRow);
    messages.put({
      ...args.message,
      id: messageId,
      chat_id: args.chatId,
      created_at: now,
      sequence: existingMessage?.sequence ?? nextSequence,
    } satisfies LocalMessageRow);
    await transactionDone(transaction);
    notifyWordChatHistoryChanged();
  } finally {
    database.close();
  }
}

export async function updateLocalWordChatModel(args: {
  documentId: string;
  ownerId: string;
  chatId: string;
  model: string;
}): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CHAT_STORE, "readwrite");
    const chats = transaction.objectStore(CHAT_STORE);
    const existing = (await requestResult(chats.get(args.chatId))) as
      | LocalChatRow
      | undefined;
    if (
      !existing ||
      existing.document_id !== args.documentId ||
      existing.owner_id !== args.ownerId
    ) {
      transaction.abort();
      throw new Error("Local Word chat is not available for this document.");
    }
    chats.put({
      ...existing,
      model: args.model,
      updated_at: new Date().toISOString(),
    } satisfies LocalChatRow);
    await transactionDone(transaction);
    notifyWordChatHistoryChanged();
  } finally {
    database.close();
  }
}

export async function updateLocalWordChatReasoning(args: {
  documentId: string;
  ownerId: string;
  chatId: string;
  reasoningLevel: import("./wordChatTypes").ReasoningLevel;
}): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CHAT_STORE, "readwrite");
    const chats = transaction.objectStore(CHAT_STORE);
    const existing = (await requestResult(chats.get(args.chatId))) as
      | LocalChatRow
      | undefined;
    if (
      !existing ||
      existing.document_id !== args.documentId ||
      existing.owner_id !== args.ownerId
    ) {
      transaction.abort();
      throw new Error("Local Word chat is not available for this document.");
    }
    chats.put({
      ...existing,
      reasoning_level: args.reasoningLevel,
      updated_at: new Date().toISOString(),
    } satisfies LocalChatRow);
    await transactionDone(transaction);
    notifyWordChatHistoryChanged();
  } finally {
    database.close();
  }
}

/**
 * Record (or clear) the turn a local chat has in flight.
 *
 * Separate from `saveLocalWordMessage` because a turn STARTS before there is
 * anything to save for the assistant, and ENDS in paths (an error, a stop
 * with nothing streamed) that write no message either. Missing rows are
 * ignored: the chat may have been deleted while its answer ran.
 */
export async function setLocalWordChatActiveTurn(args: {
  documentId: string;
  ownerId: string;
  chatId: string;
  activeTurnId: string | null;
}): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CHAT_STORE, "readwrite");
    const chats = transaction.objectStore(CHAT_STORE);
    const existing = (await requestResult(chats.get(args.chatId))) as
      | LocalChatRow
      | undefined;
    if (
      !existing ||
      existing.document_id !== args.documentId ||
      existing.owner_id !== args.ownerId
    ) {
      transaction.abort();
      return;
    }
    // Deliberately not touching `updated_at`: attaching to an answer is not
    // activity on the thread, and it must not reorder the history list.
    chats.put({
      ...existing,
      active_turn_id: args.activeTurnId,
    } satisfies LocalChatRow);
    await transactionDone(transaction);
  } catch {
    // Local bookkeeping: losing it costs a resume, never the answer.
  } finally {
    database.close();
  }
}

export async function listLocalWordChats(
  documentId: string,
  ownerId: string,
  limit: number,
  offset = 0,
): Promise<Chat[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(CHAT_STORE, "readonly");
    const index = transaction.objectStore(CHAT_STORE).index("owner_document");
    const rows = (await requestResult(
      index.getAll(IDBKeyRange.only([ownerId, documentId])),
    )) as LocalChatRow[];
    await transactionDone(transaction);
    return rows
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(offset, offset + limit);
  } finally {
    database.close();
  }
}

export async function getLocalWordChat(
  documentId: string,
  ownerId: string,
  chatId: string,
): Promise<{ chat: Chat; messages: Message[] }> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [CHAT_STORE, MESSAGE_STORE, EDIT_STORE],
      "readonly",
    );
    const chat = (await requestResult(
      transaction.objectStore(CHAT_STORE).get(chatId),
    )) as LocalChatRow | undefined;
    if (!chat || chat.document_id !== documentId || chat.owner_id !== ownerId) {
      throw new Error("Local chat not found for this document.");
    }
    const rows = (await requestResult(
      transaction
        .objectStore(MESSAGE_STORE)
        .index("chat_id")
        .getAll(IDBKeyRange.only(chatId)),
    )) as LocalMessageRow[];
    const editRows = (await requestResult(
      transaction
        .objectStore(EDIT_STORE)
        .index("owner_document")
        .getAll(IDBKeyRange.only([ownerId, documentId])),
    )) as LocalEditRow[];
    await transactionDone(transaction);
    return {
      chat,
      messages: rows
        .sort((left, right) => {
          const leftSequence = left.sequence ?? (left.role === "user" ? 0 : 1);
          const rightSequence =
            right.sequence ?? (right.role === "user" ? 0 : 1);
          return (
            leftSequence - rightSequence ||
            left.created_at.localeCompare(right.created_at) ||
            left.id.localeCompare(right.id)
          );
        })
        .map(
          ({
            chat_id: _chatId,
            created_at: _createdAt,
            sequence: _sequence,
            ...message
          }) => ({
            ...message,
            ...(message.role === "assistant"
              ? {
                  edits: editRows
                    .filter(
                      (edit) =>
                        edit.messageId === message.id &&
                        edit.document_id === documentId &&
                        edit.owner_id === ownerId,
                    )
                    .sort((left, right) => left.blockIndex - right.blockIndex)
                    .map(
                      ({
                        document_id: _documentId,
                        owner_id: _ownerId,
                        ...edit
                      }) => edit,
                    ),
                }
              : {}),
          }),
        ),
    };
  } finally {
    database.close();
  }
}

/** Permanently remove every device-only chat owned by one signed-in account. */
export async function clearLocalWordChats(ownerId: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(
      [CHAT_STORE, MESSAGE_STORE, EDIT_STORE],
      "readwrite",
    );
    const chats = transaction.objectStore(CHAT_STORE);
    const messages = transaction.objectStore(MESSAGE_STORE);
    const edits = transaction.objectStore(EDIT_STORE);
    const allChats = (await requestResult(chats.getAll())) as LocalChatRow[];
    const allEdits = (await requestResult(edits.getAll())) as LocalEditRow[];

    for (const chat of allChats) {
      if (chat.owner_id !== ownerId) continue;
      const chatMessages = (await requestResult(
        messages.index("chat_id").getAllKeys(IDBKeyRange.only(chat.id)),
      )) as IDBValidKey[];
      for (const messageId of chatMessages) messages.delete(messageId);
      for (const edit of allEdits) {
        if (
          edit.owner_id === ownerId &&
          chatMessages.some((messageId) => String(messageId) === edit.messageId)
        ) {
          edits.delete(edit.id);
        }
      }
      chats.delete(chat.id);
    }

    await transactionDone(transaction);
    notifyWordChatHistoryChanged();
  } finally {
    database.close();
  }
}
