import { getChat } from "./mikeApi";

// The request survives same-tab navigation. Keep only its lifetime and Stop
// action here; history is always loaded from the server after persistence.
type Turn = { done: Promise<void>; cancel: () => void; messageId?: string };
const turns = new Map<string, Set<Turn>>();
const listeners = new Set<(chatId: string) => void>();

export function subscribeAssistantTurns(listener: (chatId: string) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(chatId: string) {
  for (const listener of listeners) listener(chatId);
}

export function hasAssistantTurn(chatId?: string): boolean {
  return !!chatId && !!turns.get(chatId)?.size;
}

export function cancelAssistantTurn(chatId?: string) {
  if (chatId) for (const turn of turns.get(chatId) ?? []) turn.cancel();
}

export function beginAssistantTurn(
  initialChatId: string | undefined,
  cancel: () => void,
) {
  let chatId: string | undefined;
  let finished = false;
  let resolve!: () => void;
  const turn: Turn = {
    done: new Promise<void>((done) => {
      resolve = done;
    }),
    cancel,
  };
  const remove = () => {
    if (!chatId) return;
    const current = turns.get(chatId);
    current?.delete(turn);
    if (!current?.size) turns.delete(chatId);
    notify(chatId);
  };
  const identify = (id: string, messageId?: string) => {
    if (finished) return;
    if (messageId) turn.messageId = messageId;
    if (id === chatId) return;
    remove();
    chatId = id;
    const current = turns.get(id) ?? new Set<Turn>();
    current.add(turn);
    turns.set(id, current);
    notify(id);
  };
  if (initialChatId) identify(initialChatId);
  return {
    identify,
    finish() {
      if (finished) return;
      finished = true;
      remove();
      resolve();
    },
  };
}

/** Wait for this chat's response to be saved before adopting its history.
 * Subscribe across the GET too: a turn can start AND finish while that older
 * GET is in flight, in which case its incomplete snapshot must be retried.
 */
export async function loadAssistantChat(chatId: string) {
  let changed = false;
  const expectedMessages = new Set<string>();
  let persistenceDeadline = 0;
  const unsubscribe = subscribeAssistantTurns((id) => {
    if (id === chatId) changed = true;
  });
  try {
    while (true) {
      const pending = [...(turns.get(chatId) ?? [])];
      if (pending.length) {
        await Promise.all(pending.map((turn) => turn.done));
        for (const turn of pending) {
          if (turn.messageId) expectedMessages.add(turn.messageId);
        }
        if (expectedMessages.size) persistenceDeadline = Date.now() + 5000;
        continue;
      }
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
        if (!missingResponse) return result;
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
