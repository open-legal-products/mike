/**
 * Retry safety for Word edit application, exercised from the frontend test
 * runner.
 *
 * Fail-without-fix:
 * - Rejoining a turn the server is still generating replays every edit frame
 *   of that assistant message, so an edit this document already received can
 *   be delivered again under the same stable ID. The only guard was the
 *   incidental "target already has revisions" filter, which does not cover
 *   an edit whose revisions the user has since accepted — the second pass
 *   then inserted a second revision over the first. (A toast "Retry" is a
 *   new turn with a new assistant message ID, so it is not covered here.)
 * - When the verification read could not prove a faulted batch had landed,
 *   the card said "Word couldn't apply this change", which is a claim the
 *   pane cannot make, and which invites exactly the retry that duplicates.
 */
import { describe, expect, it } from "vitest";
import {
    ALREADY_APPLIED_MESSAGE,
    UNVERIFIED_APPLY_MESSAGE,
    classifyApplyFailure,
    MAX_APPLIED_EDIT_IDS,
    isEditAlreadyApplied,
    rememberAppliedEditId,
} from "../../../word-addin/src/taskpane/lib/editApplyOutcome";

describe("isEditAlreadyApplied", () => {
    const applied = new Set(["msg-1:edit-0", "msg-1:edit-1#0"]);

    it("skips an edit the document already carries", () => {
        expect(isEditAlreadyApplied("msg-1:edit-0", applied)).toBe(true);
    });

    it("applies an edit this document has never seen", () => {
        expect(isEditAlreadyApplied("msg-2:edit-0", applied)).toBe(false);
    });

    it("never skips an edit with no durable identity", () => {
        // A non-persistent apply has no stable id to key on; skipping it
        // would be guessing.
        expect(isEditAlreadyApplied(undefined, applied)).toBe(false);
        expect(isEditAlreadyApplied("", applied)).toBe(false);
    });

    it("keys per replace-all pass, so later occurrences still apply", () => {
        // A replace-all applies one occurrence per call under `${key}#${pass}`.
        expect(isEditAlreadyApplied("msg-1:edit-1#0", applied)).toBe(true);
        expect(isEditAlreadyApplied("msg-1:edit-1#1", applied)).toBe(false);
    });
});

describe("classifyApplyFailure", () => {
    it("reports an unmanaged apply when the verification read found it", () => {
        expect(
            classifyApplyFailure({
                mutationQueued: true,
                mutationApplied: true,
            }),
        ).toEqual({ status: "applied-unmanaged", reason: "word-error" });
    });

    it("refuses to guess when a queued mutation cannot be proved", () => {
        expect(
            classifyApplyFailure({
                mutationQueued: true,
                mutationApplied: false,
            }),
        ).toEqual({
            status: "error",
            reason: "unverified",
            message: UNVERIFIED_APPLY_MESSAGE,
        });
    });

    it("says plainly that nothing happened when nothing was queued", () => {
        expect(
            classifyApplyFailure({
                mutationQueued: false,
                mutationApplied: false,
            }),
        ).toEqual({ status: "error", reason: "word-error" });
    });

    it("tells the user to check the document rather than claiming a failure", () => {
        const outcome = classifyApplyFailure({
            mutationQueued: true,
            mutationApplied: false,
        });
        expect(outcome).toHaveProperty("message");
        expect(UNVERIFIED_APPLY_MESSAGE).toBe(
            "Mike couldn't confirm whether this change was applied — check the document before retrying.",
        );
        expect(UNVERIFIED_APPLY_MESSAGE).not.toContain("couldn't apply");
    });
});

describe("messages", () => {
    it("says an already-applied edit is already in the document", () => {
        expect(ALREADY_APPLIED_MESSAGE).toBe(
            "This change was already applied to the document.",
        );
    });
});

describe("rememberAppliedEditId", () => {
    const ids = (count: number): string[] =>
        Array.from({ length: count }, (_, index) => `msg-${index}:edit-0`);

    it("caps the document's list at 500 IDs", () => {
        expect(MAX_APPLIED_EDIT_IDS).toBe(500);
    });

    it("keeps all 500 when the 500th is recorded", () => {
        const next = rememberAppliedEditId(ids(499), "msg-499:edit-0");
        expect(next).toHaveLength(500);
        expect(next[0]).toBe("msg-0:edit-0");
    });

    it("drops only the oldest when the 501st is recorded", () => {
        const next = rememberAppliedEditId(ids(500), "new:edit-0");
        expect(next).toHaveLength(500);
        expect(next).not.toContain("msg-0:edit-0");
        expect(next[0]).toBe("msg-1:edit-0");
        expect(next[499]).toBe("new:edit-0");
        // The consequence of the cap: the evicted edit would apply again if
        // its frame were replayed, every newer one is still skipped.
        expect(isEditAlreadyApplied("msg-0:edit-0", new Set(next))).toBe(false);
        expect(isEditAlreadyApplied("msg-1:edit-0", new Set(next))).toBe(true);
    });

    it("does not grow or reorder on a duplicate", () => {
        const existing = ids(3);
        expect(rememberAppliedEditId(existing, "msg-0:edit-0")).toEqual(existing);
    });

    it("starts a list from empty", () => {
        expect(rememberAppliedEditId([], "a:edit-0")).toEqual(["a:edit-0"]);
    });
});
