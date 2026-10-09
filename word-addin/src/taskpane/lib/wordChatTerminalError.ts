/**
 * The server ended a Word turn with an `error` frame and a terminal `[DONE]`.
 *
 * Office-free so the classification can be asserted from the web app's test
 * runner without loading the API client.
 *
 * The backend only ever puts user-safe text in that frame (see
 * `assistantStreamErrorPayload` in backend/src/modules/chat/engine/
 * streaming.ts), so the message is marked user-visible and `describeError`
 * shows it verbatim. What the frame does NOT always mean is "try again":
 *
 * - No `safe_to_display`: the backend replaced an internal failure with its
 *   generic ASSISTANT_ERROR_MESSAGE. That is our fault and a re-send may
 *   well work, so it is a retryable server failure (support is offered).
 * - `safe_to_display: true`: the engine decided the reason is the user's own
 *   configuration (a rejected or missing API key, a model they may not use).
 *   Re-sending the same turn fails the same way, and support cannot fix a
 *   key only the user holds, so it is a non-retryable validation failure.
 *   The backend's comment on that payload says exactly this: flattening it
 *   to "try again" sends the user to retry something that cannot succeed.
 */
export class WordChatTerminalError extends Error {
  readonly userVisible = true;
  readonly kind: "server" | "validation";
  readonly retryable: boolean;
  /** Backend error code, e.g. `invalid_api_key`, when the frame carried one. */
  readonly code: string | null;

  constructor(
    message: string,
    frame: { safeToDisplay?: boolean; code?: string | null } = {},
  ) {
    super(message);
    this.name = "WordChatTerminalError";
    const usersOwnSetup = frame.safeToDisplay === true;
    this.kind = usersOwnSetup ? "validation" : "server";
    this.retryable = !usersOwnSetup;
    this.code = frame.code ?? null;
  }
}

/** Build the error from a raw SSE `error` frame. */
export function terminalErrorFromFrame(
  frame: Record<string, unknown>,
): WordChatTerminalError {
  return new WordChatTerminalError(
    typeof frame.message === "string" && frame.message
      ? frame.message
      : // Never a placeholder like "Stream error" on screen: an empty frame
        // still gets the backend's own generic sentence.
        "The response could not be completed. Please try again.",
    {
      safeToDisplay: frame.safe_to_display === true,
      code: typeof frame.code === "string" ? frame.code : null,
    },
  );
}
