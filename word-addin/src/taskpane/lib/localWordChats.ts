import type { Chat, Message, WordDocumentEdit } from "../types";
import type { PersistedWordEditPatch } from "./wordChatTypes";
import { notifyWordChatHistoryChanged } from "./wordChatHistoryEvents";
import { UserVisibleError } from "./notify";

/** Shown when this pane's code is older than the device-only chat database. */
export const OUTDATED_ADDIN_MESSAGE =
  "A newer version of Mike updated this device's chats. Close and reopen the add-in to load them.";

const DATABASE_NAME = "mike-word-addin";
// Keep the released version: an existing pane opens version 4 explicitly,
// so upgrading it would prevent that pane from saving an in-flight answer.
// Fresh databases can have the optional recency index without a version bump.
const DATABASE_VERSION = 4;
// PR previews created version 5 with only an extra index. Read those in place;
// never delete/recreate a user's database in an attempt to downgrade it.
const READABLE_PREVIEW_VERSION = 5;
const CHAT_STORE = "word-chats";
const MESSAGE_STORE = "word-chat-messages";
const EDIT_STORE = "word-document-edits";
const CHAT_RECENCY_INDEX = "owner_document_updated";
const CHAT_RECENCY_KEY = ["owner_id", "document_id", "updated_at"];

interface LocalChatRow extends Chat {
  document_id: string;
  owner_id: string;
  updated_at: string;
  /**
   * The server-owned turn this chat had in flight when the pane last wrote
   * to it. A local chat has no server row, so this is the ONLY record a
   * reopened pane has of an answer that is still being generated; it is
   * cleared after a confirmed terminal frame or an explicit Stop. A stale
   * value (the server restarted, the retention window passed) simply 404s on
   * resume.
   */
  active_turn_id?: string | null;
  /**
   * The sequence the chat's next new message receives. Absent on chats
   * written before this field (and on rows an older add-in rewrote), in
   * which case it is derived once from the message count.
   */
  next_sequence?: number;
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

function openDatabase(readPreviewVersion = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, readPreviewVersion ? undefined : DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHAT_STORE)) {
        const chats = database.createObjectStore(CHAT_STORE, { keyPath: "id" });
        chats.createIndex("document_id", "document_id", { unique: false });
        chats.createIndex("owner_document", ["owner_id", "document_id"], {
          unique: false,
        });
        chats.createIndex(CHAT_RECENCY_INDEX, CHAT_RECENCY_KEY, {
          unique: false,
        });
      } else {
        const chats = request.transaction?.objectStore(CHAT_STORE);
        if (chats && !chats.indexNames.contains("owner_document")) {
          chats.createIndex("owner_document", ["owner_id", "document_id"], {
            unique: false,
          });
        }
        // createIndex on an existing store indexes the rows already in it,
        // inside this upgrade transaction.
        if (chats && !chats.indexNames.contains(CHAT_RECENCY_INDEX)) {
          chats.createIndex(CHAT_RECENCY_INDEX, CHAT_RECENCY_KEY, {
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
    request.onsuccess = () => {
      const database = request.result;
      if (database.version > READABLE_PREVIEW_VERSION) {
        database.close();
        reject(new UserVisibleError(OUTDATED_ADDIN_MESSAGE));
        return;
      }
      // A newer add-in build (another pane, another tab) upgrading the
      // schema must not wait on this connection: close it and let the next
      // operation reopen at the new version.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => {
      // An installed PR preview may already have added the version-5 index.
      // Open its current version, then refuse unknown future schemas above.
      if (!readPreviewVersion && request.error?.name === "VersionError") {
        resolve(openDatabase(true));
        return;
      }
      reject(
        request.error ?? new Error("Could not open local Word chat storage."),
      );
    };
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
    // The counter rides on the chat row this transaction reads and writes
    // anyway. Reading every message body to find the highest sequence made
    // each save O(chat size), so a chat's lifetime of saves was O(M^2) bytes.
    //
    // Legacy rows: messages are only ever appended (one new sequence each,
    // always highest + 1, with a missing sequence counting as its position)
    // and only deleted together with their chat, so highest + 1 always
    // equals the chat's message count. count() walks keys without cloning
    // any message.
    const nextSequence =
      existing?.next_sequence ??
      (await requestResult(
        messages.index("chat_id").count(IDBKeyRange.only(args.chatId)),
      ));
    const sequence = existingMessage?.sequence ?? nextSequence;
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
      next_sequence: Math.max(nextSequence, sequence + 1),
    } satisfies LocalChatRow);
    messages.put({
      ...args.message,
      id: messageId,
      chat_id: args.chatId,
      created_at: now,
      sequence,
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
    const chats = transaction.objectStore(CHAT_STORE);
    if (!chats.indexNames.contains(CHAT_RECENCY_INDEX)) {
      // Existing v4 databases cannot gain an index without locking out older
      // panes. Retain their released listing behavior; new v4 databases and
      // v5 previews use the indexed path below. Only chat metadata is read.
      const rows = (await requestResult(
        chats.index("owner_document").getAll(IDBKeyRange.only([ownerId, documentId])),
      )) as LocalChatRow[];
      await transactionDone(transaction);
      return rows.sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(offset, offset + Math.max(0, limit));
    }
    const index = chats.index(CHAT_RECENCY_INDEX);
    // Walk this document's chats newest first and read only the page:
    // advance() skips earlier pages without cloning them. Loading and
    // sorting every chat per page made scrolling the history O(C^2 / page).
    // [owner, document] sorts below every [owner, document, updated_at] and
    // an array sorts above every string, so this range is exactly the
    // document's chats.
    const range = IDBKeyRange.bound(
      [ownerId, documentId],
      [ownerId, documentId, []],
    );
    const rows: LocalChatRow[] = [];
    if (limit > 0) {
      await new Promise<void>((resolve, reject) => {
        const request = index.openCursor(range, "prev");
        let skipped = offset === 0;
        request.onerror = () =>
          reject(request.error ?? new Error("IndexedDB request failed."));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return resolve();
          if (!skipped) {
            skipped = true;
            cursor.advance(offset);
            return;
          }
          rows.push(cursor.value as LocalChatRow);
          if (rows.length >= limit) return resolve();
          cursor.continue();
        };
      });
    }
    await transactionDone(transaction);
    return rows;
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
    // Read only this chat's edits, through the per-message index, and group
    // them once. Loading the document's edit rows (every chat) and filtering
    // them per assistant message made opening a chat cost
    // messages x all edits ever proposed in the document.
    const editIndex = transaction.objectStore(EDIT_STORE).index("message_id");
    const editRowsByMessage = new Map(
      await Promise.all(
        rows
          .filter((row) => row.role === "assistant")
          .map(
            async (row) =>
              [
                row.id,
                (
                  (await requestResult(
                    editIndex.getAll(IDBKeyRange.only(row.id)),
                  )) as LocalEditRow[]
                )
                  .filter(
                    (edit) =>
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
              ] as const,
          ),
      ),
    );
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
              ? { edits: editRowsByMessage.get(message.id) ?? [] }
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
    const ownedChats = allChats.filter((chat) => chat.owner_id === ownerId);
    // One key read per chat, issued together, then a single pass over the
    // edits against a Set (was: per chat, every edit x every message id).
    const messageKeysByChat = await Promise.all(
      ownedChats.map(
        (chat) =>
          requestResult(
            messages.index("chat_id").getAllKeys(IDBKeyRange.only(chat.id)),
          ) as Promise<IDBValidKey[]>,
      ),
    );
    const ownedMessageIds = new Set<string>();
    for (const keys of messageKeysByChat) {
      for (const messageId of keys) {
        messages.delete(messageId);
        ownedMessageIds.add(String(messageId));
      }
    }
    for (const edit of allEdits) {
      if (edit.owner_id === ownerId && ownedMessageIds.has(edit.messageId)) {
        edits.delete(edit.id);
      }
    }
    for (const chat of ownedChats) chats.delete(chat.id);

    await transactionDone(transaction);
    notifyWordChatHistoryChanged();
  } finally {
    database.close();
  }
}
