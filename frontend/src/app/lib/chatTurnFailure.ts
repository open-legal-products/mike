import { UserVisibleError, describeError } from "@/app/lib/userFacingError";

// What a chat surface says, and offers, when a turn fails. The assistant chat
// (useAssistantChat) and the tabular review chat (TRChatPanel) stream turns
// through different code, so the wording and the "may I re-send?" rule live
// here once instead of drifting apart in each.

/** A turn the server failed; re-sending it is honest. */
export const TURN_FAILED_MESSAGE = "Mike couldn't finish this answer. Try again.";

/** The bubble line for an answer whose stream broke part-way. */
export const TURN_INTERRUPTED_MESSAGE = "The answer stopped before it finished.";

/** The request may have reached the server; re-sending could ask twice. */
export const TURN_MAY_BE_RUNNING_MESSAGE =
    "The answer may still be running. Check chat history before sending the question again.";

/** A Retry raised for one thread fired after the view moved to another. */
export const CHAT_CHANGED_MESSAGE =
    "This chat has changed. Send the message again from the chat it belongs to.";

/**
 * The failure a server `error` frame stands for. `safe_to_display` marks text
 * the backend wrote for the user (a configuration refusal such as a missing
 * API key): it is shown verbatim and is not retryable, because re-sending
 * fails identically. Anything else is internal and is replaced.
 */
export function errorFrameFailure(
    message: unknown,
    safeToDisplay: boolean,
): UserVisibleError {
    const verbatim =
        safeToDisplay && typeof message === "string" && message.trim()
            ? message.trim()
            : null;
    return new UserVisibleError(verbatim ?? TURN_FAILED_MESSAGE, {
        kind: "server",
        retryable: !verbatim,
    });
}

/**
 * A lost response is not proof the POST failed. Until the server has named
 * the turn, only an explicit 4xx refusal proves nothing was stored, so any
 * other failure leaves delivery uncertain and Retry must check history
 * instead of re-sending (which would store the question twice).
 */
export function isUncertainDelivery(
    error: unknown,
    turnNamed: boolean,
): boolean {
    if (turnNamed) return false;
    const { status } = describeError(error);
    return status === null || status >= 500;
}

/**
 * The action offered instead of Retry when delivery is uncertain: re-read
 * the chat when the turn landed in a known one, otherwise refresh the list
 * so a chat the request may have created shows up.
 */
export function checkHistoryLabel(chatKnown: boolean): string {
    return chatKnown ? "Check chat" : "Refresh history";
}

export function uncertainDeliveryError(cause: unknown): UserVisibleError {
    return new UserVisibleError(TURN_MAY_BE_RUNNING_MESSAGE, { cause });
}
