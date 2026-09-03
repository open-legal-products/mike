// Data export (the route owns the Content-Type / Content-Disposition headers
// and filenames; these functions just build the payloads).
//
// Service layer behind user.routes.ts — see user.shared.ts for the module's
// contract.

import { AUDIT_EXPORT_LIMIT, parseQuery } from "../../lib/auditExport";
import { enqueueDbJob } from "../../lib/dbq/enqueue";
import {
    EXPORT_TYPES,
    MAX_ZIP_EXPORT_DOCUMENTS,
    type ExportType,
} from "../../lib/dbq/handlers";
import type { DbJob } from "../../lib/dbq/types";
import { downloadFile } from "../../lib/storage";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
} from "../../lib/userDataExport";
import { type Db, errorMessage } from "./user.shared";

export async function exportUserAccount(
    db: Db,
    userId: string,
    userEmail: string | undefined,
): Promise<{ ok: true; data: unknown } | { ok: false; error: unknown }> {
    try {
        const data = await buildUserAccountExport(db, userId, userEmail);
        return { ok: true, data };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/export] failed", { userId, error: detail });
        return { ok: false, error: err };
    }
}

export async function exportUserChats(
    db: Db,
    userId: string,
    userEmail: string | undefined,
): Promise<{ ok: true; data: unknown } | { ok: false; error: unknown }> {
    try {
        const data = await buildUserChatsExport(db, userId, userEmail);
        return { ok: true, data };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/chats/export] failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

export async function exportUserTabularReviews(
    db: Db,
    userId: string,
    userEmail: string | undefined,
): Promise<{ ok: true; data: unknown } | { ok: false; error: unknown }> {
    try {
        const data = await buildUserTabularReviewsExport(db, userId, userEmail);
        return { ok: true, data };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/tabular-reviews/export] failed", {
            userId,
            error: detail,
        });
        return { ok: false, error: err };
    }
}

// ---------------------------------------------------------------------------
// Async exports (durable): POST creates a DB-queue job that builds the
// export off the request thread; GET polls it; the download endpoint streams
// the finished artifact. The synchronous exports above still work (curl
// users, older clients) — the frontend uses this flow so a large export can
// neither time out the request nor die with a dropped tab. Artifacts expire
// after 24 hours (the runner's retention sweep deletes the file and the job
// row).

export type ValidateExportRequestResult =
    | { ok: true; type: ExportType; payload: Record<string, unknown> }
    | { ok: false; detail: string };

/**
 * Validates a POST /user/exports body and builds the job payload.
 *
 * `params` carries the inputs of the filtered exports: the History CSV's
 * filters, and the document ids of a bulk zip. They are validated here, at
 * request time, so a bad filter is a 400 instead of a job that fails minutes
 * later with nowhere to report it.
 */
export function validateExportRequest(input: {
    userId: string;
    userEmail: string | undefined;
    body: { type?: string; params?: Record<string, unknown> };
}): ValidateExportRequestResult {
    const { userId, userEmail, body } = input;
    const type = body.type;
    if (!type || !EXPORT_TYPES.includes(type as ExportType))
        return {
            ok: false,
            detail: `type must be one of: ${EXPORT_TYPES.join(", ")}`,
        };
    const params = body.params ?? {};

    const payload: Record<string, unknown> = {
        userId,
        userEmail: userEmail ?? null,
        type,
    };
    if (type === "audit-csv") {
        // Same validation the sync GET /audit/export route applies.
        const parsed = parseQuery(params, AUDIT_EXPORT_LIMIT);
        if (!parsed.ok) return { ok: false, detail: parsed.error };
        payload.query = parsed.query;
    } else if (type === "documents-zip") {
        const ids = params.document_ids;
        if (
            !Array.isArray(ids) ||
            ids.length === 0 ||
            ids.some((id) => typeof id !== "string" || !id)
        )
            return {
                ok: false,
                detail: "params.document_ids must be a non-empty array of document ids",
            };
        if (ids.length > MAX_ZIP_EXPORT_DOCUMENTS)
            return {
                ok: false,
                detail: `params.document_ids is limited to ${MAX_ZIP_EXPORT_DOCUMENTS} documents`,
            };
        payload.document_ids = ids;
    }

    return { ok: true, type: type as ExportType, payload };
}

export type StartUserExportResult =
    | { ok: true; exportId: string }
    | { ok: false; detail: string };

/** Enqueues the durable build job for an already-validated export request. */
export async function startUserExport(
    db: Db,
    input: {
        userId: string;
        type: ExportType;
        payload: Record<string, unknown>;
    },
): Promise<StartUserExportResult> {
    const { userId, type, payload } = input;
    try {
        // Deduped per (user, type) for the whole-account exports: double
        // clicks and impatient retries collapse into the already-running
        // build. The filtered exports opt out — two requests differing
        // only in their filters or selection are different artifacts.
        const dedupeKey =
            type === "audit-csv" || type === "documents-zip"
                ? undefined
                : `export:${userId}:${type}`;
        const out = await enqueueDbJob(db, {
            kind: "export.build",
            payload,
            dedupeKey,
            maxAttempts: 3,
        });
        if (!out.id) return { ok: false, detail: "Failed to schedule export" };
        return { ok: true, exportId: out.id };
    } catch (err) {
        const detail = errorMessage(err);
        console.error("[user/exports] enqueue failed", {
            userId,
            error: detail,
        });
        return { ok: false, detail };
    }
}

// Shared lookup: an export job is only visible to the user whose data it
// exports. A foreign or unknown id is a 404 either way, so ids are not
// probeable.
async function loadOwnExportJob(
    db: Db,
    exportId: string,
    userId: string,
): Promise<Pick<DbJob, "id" | "status" | "result"> | null> {
    const { data: job } = await db
        .from("db_jobs")
        .select("id, kind, status, payload, result")
        .eq("id", exportId)
        .eq("kind", "export.build")
        .maybeSingle();
    if (!job || (job.payload as { userId?: string })?.userId !== userId)
        return null;
    return job as Pick<DbJob, "id" | "status" | "result">;
}

export type UserExportStatus =
    | { ok: true; body: { status: "done"; filename: unknown } }
    | { ok: true; body: { status: "failed" } }
    | { ok: true; body: { status: "pending" } }
    | { ok: false; kind: "not_found" };

/** Poll state for GET /user/exports/:exportId. */
export async function getUserExportStatus(
    db: Db,
    exportId: string,
    userId: string,
): Promise<UserExportStatus> {
    const row = await loadOwnExportJob(db, exportId, userId);
    if (!row) return { ok: false, kind: "not_found" };
    if (row.status === "done" && row.result) {
        return {
            ok: true,
            body: { status: "done", filename: row.result.filename ?? null },
        };
    }
    if (row.status === "failed") return { ok: true, body: { status: "failed" } };
    return { ok: true, body: { status: "pending" } };
}

export type UserExportArtifact =
    | { ok: true; contentType: string; filename: string; body: Buffer }
    | { ok: false; kind: "not_found" }
    | { ok: false; kind: "expired" };

/**
 * The finished artifact for GET /user/exports/:exportId/download.
 * Authenticated + ownership-checked on every request (unlike /download/:token,
 * which only serves paths backed by a document_versions row and would 404 on
 * an export artifact); artifacts expire after 24h.
 */
export async function loadUserExportArtifact(
    db: Db,
    exportId: string,
    userId: string,
): Promise<UserExportArtifact> {
    const row = await loadOwnExportJob(db, exportId, userId);
    if (!row || row.status !== "done" || !row.result)
        return { ok: false, kind: "not_found" };
    const storagePath = row.result.storage_path as string | undefined;
    const filename =
        (row.result.filename as string | undefined) ?? "export.json";
    if (!storagePath) return { ok: false, kind: "not_found" };
    const raw = await downloadFile(storagePath);
    if (!raw) return { ok: false, kind: "expired" };
    // Artifacts are no longer all JSON (CSV, zip). The builder records the
    // type it produced; the default covers jobs finished before it did.
    return {
        ok: true,
        contentType:
            (row.result.content_type as string | undefined) ??
            "application/json",
        filename,
        body: Buffer.from(raw),
    };
}
