/**
 * What the pane may honestly offer after a Word turn failed.
 *
 * Office-free and pure so each rule can be asserted from the web app's test
 * runner without mounting the chat hook.
 *
 * - `resume`: the server told us the turn's id and never sent its terminal
 *   frame, so the answer may still be generating. Retry re-attaches to that
 *   SAME turn (replaying its frames from the start; the applied-edit registry
 *   skips edits already in the document). It never POSTs a second turn.
 * - `uncertain`: the request was posted but the pane learned neither the
 *   turn id nor a verdict (transport drop, 5xx, no status). The backend may
 *   well be running it. Re-sending could apply its edits twice, so no Retry
 *   is offered and the user is told to check history and the document.
 * - `resend`: the turn definitely did not run (it never left the pane, the
 *   server rejected it with a 4xx, or it ended with a terminal error frame),
 *   so re-sending the same submission is safe.
 * - `none`: a failed resume with nothing to re-attach to.
 */
export type FailedTurnRecovery =
  | { kind: "resume"; chatId: string; turnId: string }
  | { kind: "uncertain" }
  | { kind: "resend" }
  | { kind: "none" };

/** Shown instead of the classified error when the turn's fate is unknown. */
export const TURN_OUTCOME_UNKNOWN_MESSAGE =
  "The answer may still be running. Check chat history and the document before sending the request again.";

export function failedTurnRecovery(args: {
  /** This run started by POSTing a new turn (not by resuming one). */
  wasSend: boolean;
  /** The POST actually left the pane. */
  requestPosted: boolean;
  /** The server ended the turn with a terminal frame (`[DONE]` or `error`). */
  turnIsTerminal: boolean;
  chatId: string | null;
  turnId: string | null;
  /** HTTP status of the failure, when it had one. */
  status: number | null;
}): FailedTurnRecovery {
  if (!args.turnIsTerminal && args.chatId && args.turnId) {
    return { kind: "resume", chatId: args.chatId, turnId: args.turnId };
  }
  const verdictUnknown = args.status === null || args.status >= 500;
  if (args.requestPosted && !args.turnIsTerminal && verdictUnknown) {
    return { kind: "uncertain" };
  }
  return args.wasSend ? { kind: "resend" } : { kind: "none" };
}
