/**
 * Word add-in tracked-edit cleanup wording, exercised from the frontend test
 * runner (the add-in package has no unit-test runner of its own).
 *
 * Fail-without-fix: before this change, `removePersistentAnchorForEntry`
 * pushed `getErrorMessage(error)` — the raw Office.js text — into the same
 * list that becomes "The change was applied, but <…>. It is safe to ignore.",
 * so a user saw "GeneralException" mid-sentence.
 */
import { describe, expect, it } from "vitest";
import {
    ANCHOR_CLEANUP_FAILURE,
    BOOKMARK_CLEANUP_FAILURE,
    PROXY_CLEANUP_FAILURE,
    cleanupSentence,
} from "../../../word-addin/src/taskpane/lib/trackedEditCleanup";

describe("cleanupSentence", () => {
    it("says nothing when cleanup left nothing behind", () => {
        expect(cleanupSentence([])).toBeUndefined();
        expect(cleanupSentence(["", "   "])).toBeUndefined();
    });

    it("reports one leftover as a complete, reassuring sentence", () => {
        expect(cleanupSentence([BOOKMARK_CLEANUP_FAILURE])).toBe(
            "The change was applied, but a leftover marker could not be removed. It is safe to ignore.",
        );
    });

    it("joins two different leftovers with 'and'", () => {
        expect(
            cleanupSentence([BOOKMARK_CLEANUP_FAILURE, ANCHOR_CLEANUP_FAILURE]),
        ).toBe(
            "The change was applied, but a leftover marker could not be removed and its saved View link could not be cleared. It is safe to ignore.",
        );
    });

    it("collapses the same leftover reported by two code paths", () => {
        // The bookmark delete and the proxy untrack both leave "a leftover
        // marker"; the reader should hear about it once.
        expect(
            cleanupSentence([BOOKMARK_CLEANUP_FAILURE, PROXY_CLEANUP_FAILURE]),
        ).toBe(
            "The change was applied, but a leftover marker could not be removed. It is safe to ignore.",
        );
    });

    it("carries no host wording, whatever Office threw", () => {
        // The guard this file exists for: only fixed sentences are inputs,
        // so nothing that looks like Office.js developer text can appear.
        const sentence = cleanupSentence([
            BOOKMARK_CLEANUP_FAILURE,
            ANCHOR_CLEANUP_FAILURE,
            PROXY_CLEANUP_FAILURE,
        ]);
        expect(sentence).not.toMatch(/Exception|RichApi|Office|argument/i);
    });
});
