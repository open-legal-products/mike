import type { Document } from "../shared/types";

/**
 * How many of `documents` sit directly in each of `folderIds`, counted in
 * one pass over the documents rather than one full filter per folder.
 */
export function documentCountsByFolder(
    documents: readonly Pick<Document, "folder_id">[],
    folderIds: readonly string[],
): Record<string, number> {
    const counts = new Map<string, number>();
    for (const document of documents) {
        const folderId = document.folder_id ?? null;
        if (folderId !== null) counts.set(folderId, (counts.get(folderId) ?? 0) + 1);
    }
    return Object.fromEntries(
        folderIds.map((folderId) => [folderId, counts.get(folderId) ?? 0]),
    );
}
