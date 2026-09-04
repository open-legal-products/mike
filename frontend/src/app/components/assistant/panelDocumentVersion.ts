import type { PanelDocument } from "../shared/types";
import {
    listDocumentVersions,
    MikeApiError,
    type DocumentVersion,
} from "@/app/lib/mikeApi";

type VersionList = {
    current_version_id: string | null;
    versions: DocumentVersion[];
};

/**
 * Why this has three answers instead of two.
 *
 * A chat can be shared without its documents: the recipient of a shared
 * STANDALONE chat holds no grant on the single-documents behind it, so
 * GET /single-documents/:id/versions answers 403/404 for them. Collapsing
 * that into the same `null` as "the version list came back empty" is what
 * made citation pills dead controls — the click resolved nothing and the
 * caller returned, with no tab, no error and nothing said.
 *
 * "denied" is that case and only that case; "unavailable" is every other
 * failure (network, 5xx, a document with no versions at all), which is not
 * something to tell the reader about their access.
 */
export type PanelDocumentResolution =
    | { status: "resolved"; document: PanelDocument }
    | { status: "denied" }
    | { status: "unavailable" };

function isAccessRefusal(error: unknown): boolean {
    return (
        error instanceof MikeApiError &&
        (error.status === 403 || error.status === 404)
    );
}

export async function resolvePanelDocumentVersionResult(
    document: PanelDocument,
    loadVersions: (documentId: string) => Promise<VersionList> =
        listDocumentVersions,
): Promise<PanelDocumentResolution> {
    if (document.type === "case" || document.version_id)
        return { status: "resolved", document };

    let result: VersionList;
    try {
        result = await loadVersions(document.document_id);
    } catch (error) {
        return isAccessRefusal(error)
            ? { status: "denied" }
            : { status: "unavailable" };
    }

    const version =
        (document.version_number != null
            ? result.versions.find(
                  (candidate) =>
                      candidate.version_number === document.version_number,
              )
            : undefined) ??
        result.versions.find(
            (candidate) => candidate.id === result.current_version_id,
        );
    if (!version) return { status: "unavailable" };
    return {
        status: "resolved",
        document: {
            ...document,
            version_id: version.id,
            version_number: version.version_number,
        },
    };
}

/**
 * The document, or null when it could not be resolved for any reason.
 * Callers that need to tell a refusal apart from a failure should use
 * `resolvePanelDocumentVersionResult` directly.
 */
export async function resolvePanelDocumentVersion(
    document: PanelDocument,
    loadVersions: (documentId: string) => Promise<VersionList> =
        listDocumentVersions,
): Promise<PanelDocument | null> {
    const resolution = await resolvePanelDocumentVersionResult(
        document,
        loadVersions,
    );
    return resolution.status === "resolved" ? resolution.document : null;
}
