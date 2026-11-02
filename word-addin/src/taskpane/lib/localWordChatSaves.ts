/**
 * Saving a Word chat message to device-only storage.
 *
 * In `local` storage mode the on-device transcript is the ONLY copy: the
 * backend never persists the turn. A swallowed failure there loses the
 * user's conversation with no trace, so it is surfaced with a Retry that
 * re-saves the same message. In `cloud` mode the server already holds the
 * record and a local write is a cache, so a failure stays silent.
 *
 * The notifier is injected so the decision can be asserted without a DOM.
 */
import { UserVisibleError } from "@mike/user-error";
import { notifyError } from "./notify";
import type { WordChatStorageMode } from "./wordChatTypes";

/** What the user sees. The storage layer's own text is never shown. */
export const LOCAL_SAVE_FAILED_MESSAGE =
  "This message wasn't saved on this device, and device-only chats have no copy on the server. Try again.";

export type LocalSaveNotifier = typeof notifyError;

export async function saveWordMessageOrNotify(args: {
  storage: WordChatStorageMode;
  /** Scopes the dedupe key so two chats cannot mask each other's failure. */
  chatId: string;
  /** Re-runnable: Retry calls exactly this again. */
  save: () => Promise<unknown>;
  notify?: LocalSaveNotifier;
}): Promise<void> {
  try {
    await args.save();
  } catch (error) {
    // The server copy is the record of truth; a local cache miss is not the
    // user's problem.
    if (args.storage !== "local") return;
    const notify = args.notify ?? notifyError;
    // Declared user-visible and retryable so the toast carries the Retry:
    // an IndexedDB/quota failure classifies as "unknown", which is not
    // retryable by default, yet re-saving the same message plainly is.
    notify(
      new UserVisibleError(LOCAL_SAVE_FAILED_MESSAGE, {
        kind: "unknown",
        retryable: true,
        cause: error,
      }),
      {
        action: "save this conversation on this device",
        dedupeKey: `local-word-chat-save:${args.chatId}`,
        page: "Assistant",
        onRetry: () => saveWordMessageOrNotify(args),
      },
    );
  }
}
