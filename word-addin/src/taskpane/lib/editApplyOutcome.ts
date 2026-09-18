/**
 * Decisions that keep a user-driven "Retry" from quietly changing the
 * document twice, and that keep the pane from claiming an outcome it cannot
 * observe.
 *
 * Two facts drive the wording:
 *
 * 1. Retry resends the whole turn, so the model may re-issue an edit it
 *    already applied. Applying is not idempotent in Word — the second pass
 *    inserts a second revision over the first — so an edit whose stable ID
 *    is already recorded as applied is skipped and reported as such.
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
