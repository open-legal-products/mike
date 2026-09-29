import type { DocumentVersion } from "./mikeApi";
import type { PanelDocument } from "@/app/components/shared/types";
import { resolveDocumentViewType } from "./documentViewType";

/** Selecting a version changes the preview, never the document's active version. */
export function panelDocumentAtVersion(
    document: PanelDocument,
    version: DocumentVersion,
): PanelDocument {
    const title = version.filename ?? document.title;
    return {
        ...document,
        title,
        type: resolveDocumentViewType({
            filename: title,
            fileType: version.file_type,
        }),
        version_id: version.id,
        version_number: version.version_number,
        // Quotes and edits belong to the version they were produced against.
        quotes: [],
    };
}
