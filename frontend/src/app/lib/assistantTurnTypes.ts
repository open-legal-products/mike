import type { Message } from "@/app/components/shared/types";
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
export interface AssistantTurnHandle {
    turn: LiveAssistantTurn;
    identify(id: string, messageId?: string): void;
    cancel(): void;
    update(updater: (message: Message) => Message): void;
    setLoadingCitations(loading: boolean): void;
    finish(): void;
}
