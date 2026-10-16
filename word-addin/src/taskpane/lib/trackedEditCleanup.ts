/**
 * Wording for the best-effort cleanup that runs AFTER a tracked edit has
 * already been accepted or rejected in the document.
 *
 * None of these failures change the document outcome, so the reader only
 * needs to know what was left behind — never what Office.js called it.
 * Office's own text ("GeneralException", "The argument is invalid or missing
 * or has an incorrect format") is developer copy and stays in the console.
 *
 * Pure so the exact sentence can be asserted without Word or a browser.
 */

/** A hidden Word bookmark that could not be deleted. */
export const BOOKMARK_CLEANUP_FAILURE = "a leftover marker could not be removed";

/** The document-settings entry backing the card's "View" link. */
export const ANCHOR_CLEANUP_FAILURE =
  "its saved View link could not be cleared";

/** In-memory Word proxies that could not be untracked. */
export const PROXY_CLEANUP_FAILURE = BOOKMARK_CLEANUP_FAILURE;

/**
 * One sentence for everything cleanup left behind, or `undefined` when it
 * left nothing behind. Duplicates collapse: two code paths may report the
 * same leftover, and the user should hear about it once.
 */
export function cleanupSentence(
  failures: readonly string[],
): string | undefined {
  const unique = [
    ...new Set(failures.map((failure) => failure.trim()).filter(Boolean)),
  ];
  if (unique.length === 0) return undefined;
  const list =
    unique.length === 1
      ? unique[0]
      : `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
  return `The change was applied, but ${list}. It is safe to ignore.`;
}
