import type { ReviewItemPlacement } from "@docx-editor.dev/core/contracts/editor";

/** Resolve the clicked revision identity, never the current caret or matching text. */
export function docxReviewTarget(
    target: Element,
    items: readonly ReviewItemPlacement[],
) {
    const comment = target.closest<HTMLElement>("[data-comment-key]");
    if (comment)
        return items.find(
            (item) =>
                item.kind === "comment" &&
                item.key === comment.dataset.commentKey,
        );
    const revision = target.closest<HTMLElement>("[data-revision-id]");
    if (!revision) return undefined;
    const paragraphId = revision.closest<HTMLElement>("[data-paragraph-id]")
        ?.dataset.paragraphId;
    const partName = paragraphId?.split("#")[0];
    const matches = items.filter(
        (item) =>
            item.kind === "revision" &&
            item.item.addresses.some(
                (address) =>
                    address.id === revision.dataset.revisionId &&
                    address.author === (revision.dataset.reviewAuthor ?? "") &&
                    (address.date ?? "") ===
                        (revision.dataset.revisionDate ?? ""),
            ) &&
            (!partName ||
                item.item.ranges.some((range) => range.partName === partName)),
    );
    // Ambiguous metadata must not resolve a different change.
    return matches.length === 1 ? matches[0] : undefined;
}

type Point = { x: number; y: number };

/** Whether the point falls on a painted comment highlight (optionally the active one). */
export function docxCommentBandAt(
    surface: HTMLElement,
    point: Point,
    activeOnly = false,
) {
    const bands = surface.querySelectorAll<HTMLElement>(
        `:scope > .docx-comment-overlay > .docx-comment-band${activeOnly ? "--active" : ""}`,
    );
    return [...bands].some((band) => {
        const rect = band.getBoundingClientRect();
        return (
            point.x >= rect.left &&
            point.x <= rect.right &&
            point.y >= rect.top &&
            point.y <= rect.bottom
        );
    });
}

/**
 * The comment whose highlight was right-clicked. Painted comment bands carry no
 * identity, but pressing a mouse button moves the caret, and the engine then
 * marks the comment under the caret active and paints its band as active.
 * Requiring the point to fall on that active band keeps a caret left in another
 * comment from resolving the wrong thread. Keyboard menus use the caret directly.
 */
export function docxHighlightedComment(
    surface: HTMLElement,
    items: readonly ReviewItemPlacement[],
    point: Point | null,
) {
    const active = items.find(
        (item) => item.kind === "comment" && item.isActive,
    );
    if (!active || !point) return active;
    return docxCommentBandAt(surface, point, true) ? active : undefined;
}
