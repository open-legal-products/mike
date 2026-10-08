// Document access guards plus the list/delete operations that are pure
// row-level concerns (no version/storage orchestration beyond cleanup).

import {
    attachActiveVersionPaths,
    attachLatestVersionNumbers,
} from "../../lib/documentVersions";
import { creatorScopedAllowed, ensureDocAccess } from "../../lib/access";
import { can, type ProjectRole } from "../../lib/permissions";
import { deleteDocumentAndVersionFiles, type Db } from "./documents.shared";

type DocRow = {
    id: string;
    // Nullable since 20260902_01: content in an organization project outlives
    // the account that created it (the FK is ON DELETE SET NULL).
    user_id: string | null;
    project_id: string | null;
    org_id?: string | null;
    // Workflow-scoped documents are reachable through workflow_shares rather
    // than project sharing, so every access-checked select carries this
    // column: ensureDocAccess consults it, and the version/edit guards
    // combine it with the returned `canEdit`.
    workflow_id?: string | null;
    current_version_id?: string | null;
};

/**
 * Load a document row and verify the caller can access it. Returns the row
 * (with whatever columns `select` requested) plus the caller's derived
 * project role and creator flag — callers gate writes with
 * `can(projectRole, "content.edit")` and creator-only actions with
 * `creatorScopedAllowed` — or `{ ok: false }` when the document is missing
 * or inaccessible.
 */
export async function ensureDocumentAccess(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
    opts: { select?: string } = {},
): Promise<
    | { ok: true; doc: DocRow; isCreator: boolean; projectRole: ProjectRole }
    | { ok: false }
> {
    const { data: doc } = await db
        .from("documents")
        .select(opts.select ?? "id, user_id, project_id, org_id, workflow_id")
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
        isCreator: access.isCreator,
        projectRole: access.projectRole,
    };
}

/**
 * May the caller replace or delete this document (or one of its versions)?
 *
 * Two conditions, both required. The operation is authorship-scoped
 * (creatorScopedAllowed: the creator, or the container's Owners once the
 * creator's account is gone; workflow documents are managed at the workflow
 * share's edit tier instead). AND the caller must still hold content.edit
 * where the document lives now: being the author is provenance, not standing,
 * so a creator whose project role was reduced to Viewer has lost the right to
 * destroy content in that project like every other Viewer.
 */
export function canManageDocument(
    access: { isCreator: boolean; projectRole: ProjectRole },
    doc: { user_id: string | null; workflow_id?: string | null },
): boolean {
    if (!can(access.projectRole, "content.edit")) return false;
    return creatorScopedAllowed(access, doc.user_id) || !!doc.workflow_id;
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
    const canReplace = canManageDocument(access, access.doc);
    return { ok: true, doc: {
        ...docs[0],
        can_edit: canReplace,
        can_delete: canReplace,
    } };

}

// ---------------------------------------------------------------------------
// Delete document
// ---------------------------------------------------------------------------

// Scoped by the same rule as DELETE .../versions/:versionId, not by
// `user_id = me`: that older scope meant an org admin could not remove a
// colleague's document from a matter the firm owns, and — once account
// deletion started blanking documents.user_id instead of destroying org
// content — that NOBODY could remove a departed colleague's document.
export async function deleteDocument(
    documentId: string,
    userId: string,
    db: Db,
    userEmail?: string,
): Promise<
    | { ok: true }
    | { ok: false; kind?: undefined; error?: unknown }
    | { ok: false; kind: "forbidden"; detail: string; error?: undefined }
> {
    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id, org_id, workflow_id")
        .eq("id", documentId)
        .single();
    if (!doc) return { ok: false };
    const access = await ensureDocAccess(doc as DocRow, userId, userEmail, db);
    if (!access.ok) return { ok: false };
    if (!canManageDocument(access, doc as DocRow))
        return {
            ok: false,
            kind: "forbidden",
            detail: "You do not have permission to delete this document.",
        };

    const result = await deleteDocumentAndVersionFiles(db, documentId);
    if (result.error) return { ok: false, error: result.error };
    return { ok: true };
}
