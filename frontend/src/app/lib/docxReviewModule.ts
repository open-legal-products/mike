import type { EditorModule } from "@docx-editor.dev/core/contracts/modules";
import { collectReviewItems, revisionItemsOf } from "@docx-editor.dev/core/store";

/**
 * Mike's review integration, composed exclusively from the public Apache-2.0
 * core API. No commercial module or copied implementation is used here.
 * Keep mutations, history, protection checks and OOXML serialization in core
 * so review decisions participate in the same autosave pipeline as typing.
 */
export const docxReviewModule: EditorModule = {
    id: "mike-review",
    review: {
        displayModes: ["all-markup", "simple-markup", "proposed", "original"],
        collectReviewItems,
        revisionItemsOfParagraph: (part, paragraphId) => revisionItemsOf(part).filter((item) =>
            item.ranges.length > 0 && item.ranges.every((range) =>
                range.partName === part.name
                && range.start.paragraphId === paragraphId
                && range.end.paragraphId === paragraphId)),
    },
};

export const docxModules: readonly EditorModule[] = [docxReviewModule];
