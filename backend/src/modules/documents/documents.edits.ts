// Tracked-change (assistant edit) operations: accepting / rejecting an
// individual edit in the active DOCX.

import { randomUUID } from "node:crypto";
import { downloadFile, uploadFile, deleteFileBestEffort, versionStorageKey } from "../../lib/storage";
import { resolveTrackedChange } from "../../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../../lib/downloadTokens";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import { ensureDocAccess } from "../../lib/access";
import { can, DOCUMENT_EDIT_FORBIDDEN } from "../../lib/permissions";
import { downloadFilenameForVersion, type Db } from "./documents.shared";
import { updateDocumentVersion } from "./documents.lifecycle";
// devLog comes from lib/chat/types (a leaf file — importing the whole chat
// barrel here just for a logger would be a heavy dependency edge).
import { devLog } from "../../lib/log";

// ---------------------------------------------------------------------------
// Accept / reject a tracked-change edit
// ---------------------------------------------------------------------------

export async function resolveEdit(
    mode: "accept" | "reject",
    documentId: string,
    editId: string,
    userId: string,
    userEmail: string | undefined,
    db: Db,
): Promise<
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; detail: string; status?: number; error?: unknown }
> {
    devLog(`[edit-resolution] incoming ${mode}`, {
        userId,
        documentId,
        editId,
    });

    const { data: edit, error: editErr } = await db
        .from("document_edits")
        .select("id, document_id, change_id, del_w_id, ins_w_id, status")
        .eq("id", editId)
        .eq("document_id", documentId)
        .single();
    devLog(`[edit-resolution] fetched edit row`, { edit, editErr });
    if (!edit) {
        devLog(`[edit-resolution] edit not found, returning 404`);
        return { ok: false, detail: "Edit not found" };
    }
    // Idempotent: if the edit is already resolved, return the current doc
    // state so stale UI (e.g. an old chat reloaded in a new session) can
    // reconcile without throwing.
    if (edit.status !== "pending") {
        devLog(`[edit-resolution] edit already resolved`, {
            editId,
            status: edit.status,
        });
        const { data: doc } = await db
            .from("documents")
            .select("current_version_id, user_id, project_id, org_id, workflow_id")
            .eq("id", documentId)
            .single();
        if (!doc) {
            devLog(`[edit-resolution] doc not found for resolved edit`);
            return { ok: false, detail: "Document not found" };
        }
        const accessResolved = await ensureDocAccess(doc, userId, userEmail, db);
        if (!accessResolved.ok) {
            devLog(`[edit-resolution] doc access denied for resolved edit`);
            return { ok: false, detail: "Document not found" };
        }
        const activeForResolved = await loadActiveVersion(documentId, db);
        const payload = {
            ok: true,
            already_resolved: true,
            status: edit.status,
            version_id: doc.current_version_id ?? null,
            download_url: activeForResolved
                ? buildDownloadUrl(
                      activeForResolved.storage_path,
                      downloadFilenameForVersion(
                          activeForResolved.filename,
                          activeForResolved.version_number,
                          activeForResolved.source === "assistant_edit",
                      ),
                  )
                : null,
            remaining_pending: 0,
        };
        devLog(`[edit-resolution] returning already-resolved payload`, payload);
        return { ok: true, body: payload };
    }

    const { data: doc, error: docErr } = await db
        .from("documents")
        .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
        .eq("id", documentId)
        .single();
    devLog(`[edit-resolution] fetched doc`, { doc, docErr });
    if (!doc) return { ok: false, detail: "Document not found" };
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    // Resolving an edit rewrites the version's bytes, so read access is not
    // enough. A stranger still gets 404; a Viewer who can open the document
    // is told why instead of being told it is missing.
    if (!access.ok) return { ok: false, detail: "Document not found" };
    if (!can(access.projectRole, "content.edit"))
        return { ok: false, status: 403, detail: DOCUMENT_EDIT_FORBIDDEN };

    const active = await loadActiveVersion(documentId, db);
    const latestPath = active?.storage_path ?? null;
    devLog(`[edit-resolution] resolved latestPath`, {
        latestPath,
        current_version_id: doc.current_version_id,
    });
    if (!active || !latestPath) return { ok: false, detail: "No file to edit" };

    const raw = await downloadFile(latestPath);
    devLog(`[edit-resolution] downloaded bytes`, {
        byteLength: raw?.byteLength ?? 0,
    });
    if (!raw) return { ok: false, detail: "Document bytes not available" };

    const wIds = [edit.del_w_id, edit.ins_w_id].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
    );
    const { bytes: resolvedBytes, found } = await resolveTrackedChange(
        Buffer.from(raw),
        wIds,
        mode,
    );
    devLog(`[edit-resolution] resolveTrackedChange result`, {
        mode,
        change_id: edit.change_id,
        wIds,
        found,
        resolvedByteLength: resolvedBytes?.byteLength ?? 0,
    });
    if (!found) {
        devLog(
            `[edit-resolution] change_id not found in docx — updating status only`,
        );
        // Still update DB status so the UI reflects the decision — the change
        // may have been auto-consumed by a previous accept/reject pass.
        const { error: updErr } = await db
            .from("document_edits")
            .update({ status: mode === "accept" ? "accepted" : "rejected", resolved_at: new Date().toISOString() })
            .eq("id", editId);
        devLog(`[edit-resolution] status-only update`, { updErr });
        const payload = {
            ok: true,
            version_id: doc.current_version_id,
            download_url: buildDownloadUrl(
                latestPath,
                downloadFilenameForVersion(
                    active?.filename,
                    active?.version_number ?? null,
                    active?.source === "assistant_edit",
                ),
            ),
            remaining_pending: 0,
        };
        devLog(`[edit-resolution] returning not-found payload`, payload);
        return { ok: true, body: payload };
    }

    // Write immutable bytes first, then atomically swap the path/hash. An
    // editor save or another review action can win the same comparison, but
    // cannot overwrite an object already referenced by the winning update.
    const ab = resolvedBytes.buffer.slice(
        resolvedBytes.byteOffset,
        resolvedBytes.byteOffset + resolvedBytes.byteLength,
    ) as ArrayBuffer;
    const nextPath = versionStorageKey(userId, documentId, randomUUID(), active?.filename || "document.docx");
    await uploadFile(nextPath, ab, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const { data: updated, error: versionErr } = await updateDocumentVersion(
        db,
        documentId,
        active.id,
        {
            storage_path: nextPath,
            content_sha256: contentSha256(ab),
            pdf_storage_path: null,
            size_bytes: ab.byteLength,
        },
        { expectedStoragePath: latestPath },
    );
    if (versionErr || !updated) {
        // A definite comparison miss left the new object unreferenced. On a
        // database error the commit outcome may be unknown, so retain it.
        if (!versionErr) await deleteFileBestEffort(nextPath, "edit-resolution-conflict");
        return versionErr
            ? { ok: false, detail: "Failed to resolve edit", error: versionErr }
            : { ok: false, status: 409, detail: "This document changed. Reopen the latest version and try again." };
    }

    const { error: statusErr } = await db
        .from("document_edits")
        .update({
            status: mode === "accept" ? "accepted" : "rejected",
            resolved_at: new Date().toISOString(),
        })
        .eq("id", editId);
    devLog(`[edit-resolution] updated document_edits status`, {
        editId,
        newStatus: mode === "accept" ? "accepted" : "rejected",
        statusErr,
    });
    const { count: remainingPending } = await db
        .from("document_edits")
        .select("id", { count: "exact", head: true })
        .eq("document_id", documentId)
        .eq("status", "pending");
    devLog(`[edit-resolution] remaining pending count`, { remainingPending });

    const payload = {
        ok: true,
        version_id: doc.current_version_id,
        download_url: buildDownloadUrl(
            nextPath,
            downloadFilenameForVersion(
                active?.filename,
                active?.version_number ?? null,
                active?.source === "assistant_edit",
            ),
        ),
        remaining_pending: remainingPending ?? 0,
    };
    devLog(`[edit-resolution] returning success payload`, payload);
    return { ok: true, body: payload };
}
