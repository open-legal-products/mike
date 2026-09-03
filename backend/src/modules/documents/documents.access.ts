// Document access guards plus the list/delete operations that are pure
// row-level concerns (no version/storage orchestration beyond cleanup).

import {
    attachActiveVersionPaths,
    attachLatestVersionNumbers,
} from "../../lib/documentVersions";
import { ensureDocAccess } from "../../lib/access";
import { deleteDocumentAndVersionFiles, type Db } from "./documents.shared";

type DocRow = {
    id: string;
    user_id: string;
    project_id: string | null;
    // Workflow-scoped documents are reachable through workflow_shares rather
    // than project sharing, so every access-checked select carries this
    // column: ensureDocAccess consults it, and the version/edit guards
    // combine it with the returned `canEdit`.
    workflow_id?: string | null;
    current_version_id?: string | null;
};

/**
 * Load a document row and verify the caller can access it. Returns the row
 * (with whatever columns `select` requested) plus the owner / editor flags,
 * or `{ ok: false }` when the document is missing or inaccessible.
 */
export async function ensureDocumentAccess(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
    opts: { select?: string } = {},
): Promise<
    | { ok: true; doc: DocRow; isOwner: boolean; canEdit: boolean }
    | { ok: false }
> {
    const { data: doc } = await db
        .from("documents")
        .select(opts.select ?? "id, user_id, project_id, workflow_id")
        .eq("id", documentId)
        .single();
    if (!doc) return { ok: false };
    // `select` is a dynamic string, so supabase-js can't derive the row type.
    const d = doc as unknown as DocRow;
    const access = await ensureDocAccess(d, userId, userEmail, db);
    if (!access.ok) return { ok: false };
    return {
        ok: true,
        doc: d,
        isOwner: access.isOwner,
        canEdit: access.canEdit,
    };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listSingleDocuments(
    userId: string,
    db: Db,
): Promise<
    | { ok: true; docs: { id: string; current_version_id?: string | null }[] }
    // The raw error travels back so the route can hand it to
    // sendInternalError, which logs it and returns the opaque body.
    | { ok: false; error: unknown }
> {
    const { data, error } = await db
        .from("documents")
        .select("*")
        .eq("user_id", userId)
        .is("project_id", null)
        .or("library_kind.eq.file,library_kind.is.null")
        .order("created_at", { ascending: false });
    if (error) return { ok: false, error };
    const docs = (data ?? []) as unknown as {
        id: string;
        current_version_id?: string | null;
    }[];
    await attachLatestVersionNumbers(db, docs);
    await attachActiveVersionPaths(db, docs);
    return { ok: true, docs };
}

/**
 * One document, same shape as a list entry. Exists so the client can poll a
 * single document's status while a deferred conversion runs, instead of
 * refetching the whole collection.
 */
export async function getDocument(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
): Promise<
    | { ok: true; doc: Record<string, unknown> }
    | { ok: false; kind: "not_found" }
> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db, {
        select: "*",
    });
    if (!access.ok) return { ok: false, kind: "not_found" };

    const docs = [access.doc] as unknown as {
        id: string;
        current_version_id?: string | null;
    }[];
    await attachLatestVersionNumbers(db, docs);
    await attachActiveVersionPaths(db, docs);
    return { ok: true, doc: docs[0] as unknown as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Delete document
// ---------------------------------------------------------------------------

export async function deleteDocument(
    documentId: string,
    userId: string,
    db: Db,
): Promise<{ ok: true } | { ok: false }> {
    const { data: doc, error } = await db
        .from("documents")
        .select("id")
        .eq("id", documentId)
        .eq("user_id", userId)
        .single();
    if (error || !doc) return { ok: false };

    await deleteDocumentAndVersionFiles(db, documentId);
    return { ok: true };
}
