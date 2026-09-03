// Read/serve paths for documents: inline display bytes, zip bundling, signed
// download URLs, and raw DOCX bytes.

import { downloadFile, getSignedUrl, headFile } from "../../lib/storage";
import {
    attachActiveVersionPaths,
    loadActiveVersion,
} from "../../lib/documentVersions";
import { checkProjectAccess, ensureDocAccess } from "../../lib/access";
import { mapWithConcurrency } from "../../lib/concurrency";
import { zipExportLimitDetail } from "../../lib/zipExport";
import {
    loadDocumentDisplay,
    type DocumentDisplayPayload,
} from "../../lib/documentDisplay";
import { downloadFilenameForVersion, type Db } from "./documents.shared";
import { ensureDocumentAccess } from "./documents.access";

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

/**
 * Resolve the payload to serve inline for a document's display view. The
 * rendition logic (stored PDF, LibreOffice fallback, raw bytes) lives in
 * lib/documentDisplay so every preview surface renders identically; the route
 * hands the returned payload to `sendDocumentDisplay`.
 *
 * A conversion failure throws out of `loadDocumentDisplay`, so it is reported
 * separately from the 404 paths: the route maps it to an internal error.
 */
export async function getDisplayableVersion(
    documentId: string,
    userId: string,
    userEmail: string,
    versionIdParam: string | null,
    db: Db,
): Promise<
    | { ok: true; display: DocumentDisplayPayload }
    | { ok: false; kind: "not_found"; detail: string }
    | { ok: false; kind: "error"; error: unknown }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, kind: "not_found", detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
        return { ok: false, kind: "not_found", detail: "No file available" };

    const displayFilename = downloadFilenameForVersion(
        active.filename,
        active.version_number,
        active.source === "assistant_edit",
    );

    try {
        const display = await loadDocumentDisplay({
            filename: displayFilename,
            fileType: active.file_type,
            storagePath: active.storage_path,
            pdfStoragePath: active.pdf_storage_path,
        });
        if (!display)
            return {
                ok: false,
                kind: "not_found",
                detail: "Document not found in storage",
            };
        return { ok: true, display };
    } catch (error) {
        return { ok: false, kind: "error", error };
    }
}

// ---------------------------------------------------------------------------
// Download zip
// ---------------------------------------------------------------------------

/**
 * Expand a set of selected folders into every folder id beneath them.
 * `allFolders` is the caller's full folder set for the relevant scope, so the
 * walk is a fixpoint over an in-memory list rather than one query per level.
 */
export function collectFolderDescendantIds(
    roots: Array<{ id: unknown }>,
    allFolders: Array<{ id: unknown; parent_folder_id: unknown }>,
) {
    const selected = new Set(roots.map((folder) => String(folder.id)));
    let changed = true;
    while (changed) {
        changed = false;
        for (const folder of allFolders) {
            const id = String(folder.id);
            const parentId = folder.parent_folder_id
                ? String(folder.parent_folder_id)
                : null;
            if (!parentId || !selected.has(parentId) || selected.has(id))
                continue;
            selected.add(id);
            changed = true;
        }
    }
    return [...selected];
}

// A `type` (not an interface) so it keeps the implicit index signature that
// attachActiveVersionPaths's row constraint requires.
type DownloadDocumentRow = {
    id: string;
    current_version_id?: string | null;
    user_id: string;
    project_id: string | null;
    storage_path?: string | null;
    filename?: string | null;
    source?: string | null;
    active_version_number?: number | null;
};

/** One file to place in the archive, already named and sized. */
export type ZipExportEntry = {
    storagePath: string;
    filename: string;
    size: number;
};

/**
 * Resolve the exportable files behind a zip request: the requested documents
 * plus everything inside the requested project / library folders, filtered to
 * what the caller may read, restricted to versions that still have bytes, and
 * bounded by the document-count and total-size limits.
 *
 * Returns entries only — the route streams the archive, because that loop is
 * an HTTP concern (it applies backpressure onto `res`).
 */
export async function resolveZipExportDocuments(
    params: {
        documentIds: string[];
        folderIds: string[];
        userId: string;
        userEmail: string | undefined;
    },
    db: Db,
): Promise<
    | { ok: true; entries: ZipExportEntry[] }
    | { ok: false; kind: "limit"; detail: string }
    | { ok: false; kind: "not_found"; detail: string }
    // Database and object-storage failures are opaque to the client: the
    // route hands the raw error to sendInternalError.
    | { ok: false; kind: "internal"; error: unknown }
> {
    const { documentIds, folderIds, userId, userEmail } = params;

    // Bound the *requested* count before any query runs, so an oversized
    // selection cannot cost a database round-trip.
    const requestedCountLimit = zipExportLimitDetail(documentIds.length, 0);
    if (requestedCountLimit)
        return { ok: false, kind: "limit", detail: requestedCountLimit };

    const rawDocsById = new Map<string, DownloadDocumentRow>();

    if (documentIds.length > 0) {
        const { data, error } = await db
            .from("documents")
            .select("id, current_version_id, user_id, project_id, workflow_id")
            .in("id", documentIds);
        if (error) return { ok: false, kind: "internal", error };
        for (const doc of data ?? [])
            rawDocsById.set(doc.id as string, doc as DownloadDocumentRow);
    }

    if (folderIds.length > 0) {
        const [projectRootsResult, libraryRootsResult] = await Promise.all([
            db
                .from("project_subfolders")
                .select("id, project_id, parent_folder_id")
                .in("id", folderIds),
            db
                .from("library_folders")
                .select("id, user_id, library_kind, parent_folder_id")
                .in("id", folderIds)
                .eq("user_id", userId),
        ]);
        if (projectRootsResult.error)
            return {
                ok: false,
                kind: "internal",
                error: projectRootsResult.error,
            };
        if (libraryRootsResult.error)
            return {
                ok: false,
                kind: "internal",
                error: libraryRootsResult.error,
            };

        const projectRoots = projectRootsResult.data ?? [];
        const projectIds = [
            ...new Set(
                projectRoots.map((folder) => folder.project_id as string),
            ),
        ];
        const accessibleProjectIds = (
            await Promise.all(
                projectIds.map(async (projectId) => ({
                    projectId,
                    access: await checkProjectAccess(
                        projectId,
                        userId,
                        userEmail,
                        db,
                    ),
                })),
            )
        )
            .filter((result) => result.access.ok)
            .map((result) => result.projectId);

        const accessibleProjectRoots = projectRoots.filter((folder) =>
            accessibleProjectIds.includes(folder.project_id as string),
        );
        const libraryRoots = libraryRootsResult.data ?? [];
        const libraryKinds = [
            ...new Set(
                libraryRoots.map((folder) => folder.library_kind as string),
            ),
        ];

        const [projectFoldersResult, libraryFoldersResult] = await Promise.all([
            accessibleProjectIds.length > 0
                ? db
                      .from("project_subfolders")
                      .select("id, project_id, parent_folder_id")
                      .in("project_id", accessibleProjectIds)
                : Promise.resolve({ data: [], error: null }),
            libraryKinds.length > 0
                ? db
                      .from("library_folders")
                      .select("id, user_id, library_kind, parent_folder_id")
                      .eq("user_id", userId)
                      .in("library_kind", libraryKinds)
                : Promise.resolve({ data: [], error: null }),
        ]);
        if (projectFoldersResult.error)
            return {
                ok: false,
                kind: "internal",
                error: projectFoldersResult.error,
            };
        if (libraryFoldersResult.error)
            return {
                ok: false,
                kind: "internal",
                error: libraryFoldersResult.error,
            };

        const projectFolderIds = collectFolderDescendantIds(
            accessibleProjectRoots,
            projectFoldersResult.data ?? [],
        );
        const libraryFolderIds = collectFolderDescendantIds(
            libraryRoots,
            libraryFoldersResult.data ?? [],
        );

        const folderDocumentResults = await Promise.all([
            projectFolderIds.length > 0
                ? db
                      .from("documents")
                      .select(
                          "id, current_version_id, user_id, project_id, workflow_id",
                      )
                      .in("folder_id", projectFolderIds)
                : Promise.resolve({ data: [], error: null }),
            libraryFolderIds.length > 0
                ? db
                      .from("documents")
                      .select(
                          "id, current_version_id, user_id, project_id, workflow_id",
                      )
                      .in("library_folder_id", libraryFolderIds)
                : Promise.resolve({ data: [], error: null }),
        ]);
        for (const result of folderDocumentResults) {
            if (result.error)
                return { ok: false, kind: "internal", error: result.error };
            for (const doc of result.data ?? [])
                rawDocsById.set(doc.id as string, doc as DownloadDocumentRow);
        }
    }

    // Folder expansion can multiply the selection well past the requested
    // count, so re-check the bound on what actually resolved.
    const resolvedCountLimit = zipExportLimitDetail(rawDocsById.size, 0);
    if (resolvedCountLimit)
        return { ok: false, kind: "limit", detail: resolvedCountLimit };

    // Filter to docs the user actually has access to (own + shared-project).
    const accessChecks = await Promise.all(
        [...rawDocsById.values()].map(async (d) => ({
            doc: d,
            access: await ensureDocAccess(
                d as { user_id: string; project_id: string | null },
                userId,
                userEmail,
                db,
            ),
        })),
    );
    const docs = accessChecks.filter((x) => x.access.ok).map((x) => x.doc);
    if (docs.length === 0)
        return { ok: false, kind: "not_found", detail: "No documents found" };

    await attachActiveVersionPaths(db, docs);
    const activeDocs = docs.filter(
        (
            doc,
        ): doc is DownloadDocumentRow & {
            storage_path: string;
        } => typeof doc.storage_path === "string" && doc.storage_path.length > 0,
    );
    if (activeDocs.length === 0)
        return { ok: false, kind: "not_found", detail: "No files available" };

    // HEAD every object to learn the archive's total size before committing to
    // it; bounded concurrency keeps a large selection from opening one request
    // per document at once.
    let sized: Array<{ doc: (typeof activeDocs)[number]; size: number }>;
    try {
        sized = (
            await mapWithConcurrency(activeDocs, 5, async (doc) => ({
                doc,
                metadata: await headFile(doc.storage_path),
            }))
        )
            .filter(
                (
                    entry,
                ): entry is {
                    doc: (typeof activeDocs)[number];
                    metadata: NonNullable<Awaited<ReturnType<typeof headFile>>>;
                } => entry.metadata != null,
            )
            .map(({ doc, metadata }) => ({ doc, size: metadata.size }));
    } catch (error) {
        return { ok: false, kind: "internal", error };
    }
    if (sized.length === 0)
        return { ok: false, kind: "not_found", detail: "No files available" };

    const sizeLimit = zipExportLimitDetail(
        sized.length,
        sized.reduce((total, entry) => total + entry.size, 0),
    );
    if (sizeLimit) return { ok: false, kind: "limit", detail: sizeLimit };

    return {
        ok: true,
        entries: sized.map(({ doc, size }) => ({
            storagePath: doc.storage_path,
            filename: downloadFilenameForVersion(
                doc.filename,
                doc.active_version_number ?? null,
                doc.source === "assistant_edit",
            ),
            size,
        })),
    };
}

// ---------------------------------------------------------------------------
// Signed download URL
// ---------------------------------------------------------------------------

export async function getDownloadUrl(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
): Promise<
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; kind: "not_found"; detail: string }
    | { ok: false; kind: "storage"; detail: string }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok)
        return { ok: false, kind: "not_found", detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active)
        return { ok: false, kind: "not_found", detail: "No file available" };

    const downloadFilename = downloadFilenameForVersion(
        active.filename,
        active.version_number,
        active.source === "assistant_edit",
    );
    const url = await getSignedUrl(active.storage_path, 3600, downloadFilename);
    if (!url)
        return { ok: false, kind: "storage", detail: "Storage not configured" };

    return {
        ok: true,
        payload: {
            url,
            document_id: documentId,
            filename: downloadFilename,
            version_id: active.id,
            // Lets the frontend decide between DocView (PDF.js) and DocxView
            // (docx-preview) without a follow-up round-trip.
            has_pdf_rendition: !!active.pdf_storage_path,
        },
    };
}

// ---------------------------------------------------------------------------
// Raw DOCX bytes
// ---------------------------------------------------------------------------

export async function getDocxBytes(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
): Promise<
    | { ok: true; bytes: ArrayBuffer; filename: string }
    | { ok: false; detail: string }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return { ok: false, detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active) return { ok: false, detail: "No file available" };

    const raw = await downloadFile(active.storage_path);
    if (!raw) return { ok: false, detail: "Document bytes not available" };

    return {
        ok: true,
        bytes: raw,
        filename: downloadFilenameForVersion(
            active.filename,
            active.version_number,
            active.source === "assistant_edit",
        ),
    };
}
