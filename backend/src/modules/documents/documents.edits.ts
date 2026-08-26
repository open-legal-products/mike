// Tracked-change (assistant edit) operations: listing change ids embedded in
// the active DOCX and accepting / rejecting an individual edit.

import { downloadFile, extractedTextKey, uploadFile } from "../../lib/storage";
import { enqueueStorageCleanup } from "../../lib/dbq/enqueue";
import {
    extractTrackedChangeIds,
    resolveTrackedChange,
} from "../../lib/docxTrackedChanges";
import { buildDownloadUrl } from "../../lib/downloadTokens";
import { contentSha256, loadActiveVersion } from "../../lib/documentVersions";
import { ensureDocAccess } from "../../lib/access";
import { downloadFilenameForVersion, type Db } from "./documents.shared";
import { ensureDocumentAccess } from "./documents.access";
import { devLog } from "../../lib/chat/types";

// ---------------------------------------------------------------------------
// Tracked-change ids
// ---------------------------------------------------------------------------

export async function getTrackedChangeIds(
    documentId: string,
    userId: string,
    userEmail: string | undefined,
    versionIdParam: string | null,
    db: Db,
): Promise<{ ok: true; ids: unknown } | { ok: false; detail: string }> {
    const access = await ensureDocumentAccess(documentId, userId, userEmail, db);
    if (!access.ok) return { ok: false, detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db, versionIdParam);
    if (!active) return { ok: false, detail: "No file available" };

    const raw = await downloadFile(active.storage_path);
    if (!raw) return { ok: false, detail: "Document bytes not available" };

    const ids = await extractTrackedChangeIds(Buffer.from(raw));
    return { ok: true, ids };
}

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
    | { ok: false; detail: string }
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
            .select("current_version_id, user_id, project_id")
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
        .select("id, current_version_id, user_id, project_id")
        .eq("id", documentId)
        .single();
    devLog(`[edit-resolution] fetched doc`, { doc, docErr });
    if (!doc) return { ok: false, detail: "Document not found" };
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok) return { ok: false, detail: "Document not found" };

    const active = await loadActiveVersion(documentId, db);
    const latestPath = active?.storage_path ?? null;
    devLog(`[edit-resolution] resolved latestPath`, {
        latestPath,
        current_version_id: doc.current_version_id,
    });
    if (!latestPath) return { ok: false, detail: "No file to edit" };

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

    // Overwrite bytes in place at the current version's storage path —
    // accept/reject mutates the existing version rather than spawning a
    // new row. This keeps document_versions lean (one row per assistant
    // edit, not one per accept/reject click) and avoids the N-versions-
    // per-doc churn as users resolve pending changes.
    const ab = resolvedBytes.buffer.slice(
        resolvedBytes.byteOffset,
        resolvedBytes.byteOffset + resolvedBytes.byteLength,
    ) as ArrayBuffer;

    // Clear the hash before the bytes change, and set it again after. The stored
    // object and the hash live in different systems, so they cannot be written
    // atomically; ordering it this way means a failure in between leaves the
    // version unhashed, which the manifest reports as unverifiable. The
    // alternative ordering can leave a hash attesting to content the version no
    // longer holds, which is the one thing the manifest must never do.
    await db
        .from("document_versions")
        .update({ content_sha256: null })
        .eq("id", doc.current_version_id);

    devLog(`[edit-resolution] overwriting bytes in place`, {
        latestPath,
        byteLength: ab.byteLength,
    });
    await uploadFile(
        latestPath,
        ab,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    // pdf_storage_path: null — the bytes just changed, so any PDF rendition
    // this version carried no longer matches them; a stale rendition would be
    // served by /display and copied onto replicas by replicate_document. In
    // practice assistant_edit versions never carry one (DOCX renders through
    // DocxView from the raw bytes), so this is an invariant write, not a
    // behavior change.
    await db
        .from("document_versions")
        .update({ content_sha256: contentSha256(ab), pdf_storage_path: null })
        .eq("id", doc.current_version_id);

    // The extracted-text cache is keyed on the version id and this is one of
    // only two sites that rewrite a version's bytes in place, so it is one of
    // only two sites where that key could go stale. Resolution always writes
    // DOCX, which is not a cached type, so this deletes nothing today — it is
    // here so the "versions are immutable" assumption the cache rests on stays
    // true by construction rather than by coincidence.
    await enqueueStorageCleanup(db, [
        extractedTextKey(doc.current_version_id as string),
    ]);

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
            latestPath,
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
