import type {
  ActiveAssistantTurn,
  Message,
} from "@/app/components/shared/types";
import { getChat, stopChatTurn, streamChatTurn } from "./mikeApi";
import {
  createTurnCursor,
  createTurnEventSink,
  isAbortError,
  readAssistantTurn,
} from "./assistantTurnStream";

/**
 * In-flight assistant turns, keyed by chat id, that survive same-tab
 * navigation.
 *
 * A turn is the request `useAssistantChat` sends plus the assistant message it
 * builds from the stream. The registry, not the hook that sent the request,
 * owns that message while it streams. So a hook that comes back to the thread
 * (a chat switch and return, or a fresh mount of the page) attaches to the
 * turn and shows the same live answer the sender saw, token by token, instead
 * of a loading state that lasts until the server has stored the answer. Only
 * the Stop control ends a turn early.
 */
export type LiveAssistantTurn = {
  /** The chat this turn belongs to, once the stream has named it. */
  readonly chatId: string | undefined;
  /**
   * The user message this turn answers, or null when it continues an
   * existing assistant message instead (an ask-inputs answer).
   */
  readonly userMessage: Message | null;
  /** The assistant message as built from the stream so far. */
  readonly assistant: Message;
  readonly loadingCitations: boolean;
  /** Set once the stream has ended, whether it finished, failed or was stopped. */
  readonly finished: boolean;
  /**
   * Fires after every change to `assistant` or `loadingCitations`, and once
   * more when the turn finishes.
   */
  subscribe(listener: () => void): () => void;
};

type TurnRecord = {
  chatId: string | undefined;
  userMessage: Message | null;
  assistant: Message;
  loadingCitations: boolean;
  finished: boolean;
  done: Promise<void>;
  cancel: () => void;
  listeners: Set<() => void>;
  subscribe(listener: () => void): () => void;
};

type RegistryChange = "begin" | "finish";
type RegistryListener = (
  chatId: string,
  change: RegistryChange,
  turn: LiveAssistantTurn,
) => void;

const turns = new Map<string, Set<TurnRecord>>();
const listeners = new Set<RegistryListener>();

/** Membership changes only: a turn appearing in, or leaving, a chat. */
export function subscribeAssistantTurns(listener: RegistryListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(chatId: string, change: RegistryChange, turn: TurnRecord) {
  for (const listener of listeners) listener(chatId, change, turn);
}

export function hasAssistantTurn(chatId?: string): boolean {
  return !!chatId && !!turns.get(chatId)?.size;
}

/** The turn currently streaming into this chat, if any. */
export function getAssistantTurn(chatId?: string): LiveAssistantTurn | null {
  if (!chatId) return null;
  let latest: TurnRecord | null = null;
  for (const turn of turns.get(chatId) ?? []) latest = turn;
  return latest;
}

export function cancelAssistantTurn(chatId?: string) {
  if (chatId) for (const turn of turns.get(chatId) ?? []) turn.cancel();
}

export function beginAssistantTurn(
  initialChatId: string | undefined,
  options: {
    userMessage: Message | null;
    assistant: Message;
    cancel: () => void;
  },
) {
  let resolve!: () => void;
  const record: TurnRecord = {
    chatId: undefined,
    userMessage: options.userMessage,
    assistant: options.assistant,
    loadingCitations: false,
    finished: false,
    done: new Promise<void>((done) => {
      resolve = done;
    }),
    cancel: options.cancel,
    listeners: new Set(),
    subscribe(listener) {
      record.listeners.add(listener);
      return () => {
        record.listeners.delete(listener);
      };
    },
  };
  const publish = () => {
    for (const listener of [...record.listeners]) listener();
  };
  const remove = () => {
    const { chatId } = record;
    if (!chatId) return;
    const current = turns.get(chatId);
    current?.delete(record);
    if (!current?.size) turns.delete(chatId);
    notify(chatId, "finish", record);
  };
  const identify = (id: string, messageId?: string) => {
    if (record.finished) return;
    if (messageId && record.assistant.id !== messageId) {
      record.assistant = { ...record.assistant, id: messageId };
      publish();
    }
    if (id === record.chatId) return;
    remove();
    record.chatId = id;
    const current = turns.get(id) ?? new Set<TurnRecord>();
    current.add(record);
    turns.set(id, current);
    notify(id, "begin", record);
  };
  if (initialChatId) identify(initialChatId);
  return {
    turn: record as LiveAssistantTurn,
    identify,
    cancel() {
      record.cancel();
    },
    /** Replace the assistant message. Ignored once the turn has finished. */
    update(updater: (message: Message) => Message) {
      if (record.finished) return;
      record.assistant = updater(record.assistant);
      publish();
    },
    setLoadingCitations(loading: boolean) {
      if (record.finished || record.loadingCitations === loading) return;
      record.loadingCitations = loading;
      publish();
    },
    finish() {
      if (record.finished) return;
      record.finished = true;
      record.loadingCitations = false;
      publish();
      remove();
      resolve();
    },
  };
}

export type AssistantTurnHandle = ReturnType<typeof beginAssistantTurn>;

/**
 * Lay a turn's messages over a transcript.
 *
 * The transcript may be the sender's own list (which already ends with this
 * turn's user message and an assistant placeholder), a history just loaded
 * from the server (which has the user row, and hides the assistant row until
 * it has content), or a stale history read before the turn was stored. The
 * assistant row is matched by id first; a trailing assistant row without an
 * id is this turn's own placeholder, since stored rows always carry ids.
 * Otherwise the turn's messages are appended, minus a user message the
 * transcript already ends with.
 */
export function withLiveTurn(
  messages: Message[],
  turn: LiveAssistantTurn | null,
): Message[] {
  if (!turn) return messages;
  const { assistant, userMessage } = turn;
  if (assistant.id) {
    const index = messages.findIndex(
      (message) => message.role === "assistant" && message.id === assistant.id,
    );
    if (index >= 0) {
      const next = [...messages];
      next[index] = assistant;
      return next;
    }
  }
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && !last.id) {
    return [...messages.slice(0, -1), assistant];
  }
  const userShown =
    !!userMessage &&
    last?.role === "user" &&
    (userMessage.id ? last.id === userMessage.id : true) &&
    last.content === userMessage.content;
  return [
    ...messages,
    ...(userMessage && !userShown ? [userMessage] : []),
    assistant,
  ];
}

/**
 * Attach to a turn the server is generating for this chat that no hook in
 * this page knows about — the page was reloaded, or this is a second tab.
 * The record it creates is what every hook viewing the chat mirrors, so the
 * answer resumes on screen exactly as if the request had been sent here.
 * Stop from this page goes to the server's Stop endpoint like any other.
 */
export function resumeAssistantTurn(
  chatId: string,
  active: ActiveAssistantTurn,
): void {
  if (hasAssistantTurn(chatId)) return;
  const controller = new AbortController();
  const cursor = createTurnCursor(chatId);
  cursor.turnId = active.id;
  const handle = beginAssistantTurn(chatId, {
    userMessage: null,
    assistant: {
      ...(active.assistant_message_id ? { id: active.assistant_message_id } : {}),
      role: "assistant",
      content: "",
      citations: [],
      events: [],
    },
    cancel: () => {
      void stopChatTurn(chatId, active.id).catch(() => {});
      controller.abort();
      sink.appendCancellation();
      handle.finish();
    },
  });
  const sink = createTurnEventSink(handle, []);
  void readAssistantTurn({
    open: () =>
      streamChatTurn({ chatId, turnId: active.id, from: 1, signal: controller.signal }),
    turn: handle,
    sink,
    cursor,
    signal: controller.signal,
  })
    .catch((error: unknown) => {
      sink.finalizeStreamingContent();
      if (isAbortError(error)) {
        sink.appendCancellation();
        return;
      }
      handle.update((message) => ({
        ...message,
        error: "Sorry, something went wrong.",
      }));
    })
    .finally(() => handle.finish());
}

/**
 * Load a chat's history without waiting for a turn that is still streaming
 * into it; the caller overlays that turn with `withLiveTurn`. A turn the
 * server reports as still generating, and that no hook here started, is
 * resumed from the server's copy before the history is handed back. A turn that
 * starts or finishes during the GET invalidates the read, because the
 * snapshot may predate the row it stored: the read is retried, and bounded
 * polling covers the window in which Stop has closed the socket before the
 * backend has written the cancellation row.
 */
export async function loadAssistantChat(chatId: string) {
  let changed = false;
  const expectedMessages = new Set<string>();
  let persistenceDeadline = 0;
  const unsubscribe = subscribeAssistantTurns((id, change, turn) => {
    if (id !== chatId) return;
    changed = true;
    if (change === "finish" && turn.assistant.id) {
      expectedMessages.add(turn.assistant.id);
      persistenceDeadline = Date.now() + 5000;
    }
  });
  try {
    while (true) {
      changed = false;
      try {
        const result = await getChat(chatId);
        if (changed) continue;
        // Stop closes the socket before the backend saves the cancellation.
        // A returning reader must not adopt the empty reserved row in that
        // brief window. Bound recovery so a failed server write surfaces as
        // a load error instead of leaving the composer waiting forever.
        const missingResponse = [...expectedMessages].some(
          (id) => !result.messages.some((message) => message.id === id),
        );
        if (!missingResponse) {
          if (result.active_turn) resumeAssistantTurn(chatId, result.active_turn);
          return result;
        }
        if (Date.now() >= persistenceDeadline) {
          throw new Error("Chat response could not be loaded");
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (error) {
        // An invalidated read can fail while a new turn is being saved.
        // Retry that read, but preserve ordinary load failures for the page.
        if (!changed) throw error;
      }
    }
  } finally {
    unsubscribe();
  }
}
