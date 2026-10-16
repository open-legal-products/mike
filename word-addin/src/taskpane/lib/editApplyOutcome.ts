/**
 * Decisions that keep a user-driven "Retry" from quietly changing the
 * document twice, and that keep the pane from claiming an outcome it cannot
 * observe.
 *
 * Two facts drive the wording:
 *
 * 1. The same edit can be delivered to the pane twice. Rejoining a turn the
 *    server is still generating (a reopened pane resumes from frame 1, see
 *    `resumeTurn` in useWordAssistantChat) replays every edit frame of that
 *    assistant message, including ones this document already received.
 *    Applying is not idempotent in Word — the second pass inserts a second
 *    revision over the first — so an edit whose stable ID
 *    (`${assistantMessageId}:edit-${blockIndex}`) is already recorded as
 *    applied is skipped and reported as such. A user-driven Retry is NOT
 *    covered: it is a new turn with a new assistant message ID, so its edits
 *    have new stable IDs.
 * 2. A Word batch can fail after Word has already executed some of its
 *    queued commands. When the verification read cannot prove either way,
 *    the honest answer is "I don't know", and the card must not invite a
 *    retry that could double-apply.
 *
 * Pure, so both rules can be asserted without Word.
 */

/** Shown when an edit's stable ID is already in the document's applied set. */
export const ALREADY_APPLIED_MESSAGE =
  "This change was already applied to the document.";

/** Shown when Word faulted and the verification read proved nothing. */
export const UNVERIFIED_APPLY_MESSAGE =
  "Mike couldn't confirm whether this change was applied — check the document before retrying.";

/**
 * How many applied stable edit IDs a document remembers. Office document
 * settings are serialized into the file and read synchronously on load, so
 * the list is capped; at roughly 50 bytes per ID this is about 25 KB. An edit
 * pushed out is one whose turn ended hundreds of edits ago, far outside any
 * window in which the same message can be re-delivered.
 */
export const MAX_APPLIED_EDIT_IDS = 500;

/**
 * The applied-ID list after recording `stableEditId`: unchanged if already
 * present, otherwise appended with the OLDEST entries dropped past `max`.
 * Pure so the cap boundary can be asserted without Word.
 */
export function rememberAppliedEditId(
  existing: readonly string[],
  stableEditId: string,
  max: number = MAX_APPLIED_EDIT_IDS,
): string[] {
  if (existing.includes(stableEditId)) return [...existing];
  return [...existing, stableEditId].slice(-max);
}

/**
 * Whether this edit must be skipped because the document already carries it.
 * An edit with no stable ID (a non-persistent, single-session apply) has no
 * durable identity to key on and is always applied.
 */
export function isEditAlreadyApplied(
  stableEditId: string | undefined,
  appliedEditIds: ReadonlySet<string>,
): boolean {
  return !!stableEditId && appliedEditIds.has(stableEditId);
}

export type ApplyFailureOutcome =
  | { status: "applied-unmanaged"; reason: "word-error" }
  | { status: "error"; reason: "unverified"; message: string }
  | { status: "error"; reason: "word-error" };

/**
 * What to report when the Word batch for one edit threw.
 *
 * - The verification read found the expected revisions: it landed, Mike just
 *   lost its review controls.
 * - A mutation was queued but nothing could prove it landed: unknown. No
 *   automatic retry, because retrying an edit that DID land duplicates it.
 * - Nothing was ever queued: the edit definitely did not happen, so the
 *   plain "couldn't apply" wording (and a retry) is honest.
 */
export function classifyApplyFailure(args: {
  mutationQueued: boolean;
  mutationApplied: boolean;
}): ApplyFailureOutcome {
  if (args.mutationApplied) {
    return { status: "applied-unmanaged", reason: "word-error" };
  }
  if (args.mutationQueued) {
    return {
      status: "error",
      reason: "unverified",
      message: UNVERIFIED_APPLY_MESSAGE,
    };
  }
  return { status: "error", reason: "word-error" };
}
