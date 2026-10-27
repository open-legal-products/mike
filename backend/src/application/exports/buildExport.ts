// Re-authorize and build a durable export artifact. Retried requests overwrite the same path.
import { recordAudit } from "../../lib/audit";
import {
    buildUserAccountExport,
    buildUserChatsExport,
    buildUserTabularReviewsExport,
    userExportFilename,
} from "./buildJsonExport";
import { AUDIT_CSV_FILENAME, buildAuditCsv, type AuditQuery } from "../../lib/auditExport";
import { ensureDocAccess } from "../../lib/access";
import { downloadFilenameForVersion, loadActiveVersion } from "../../lib/documentVersions";
import { downloadFile, uploadFile } from "../../lib/storage";
import type { Db } from "../../lib/supabase";
import type { ExportBuildRequest } from "./exportContracts";
import { buildMemoryArchive } from "../../lib/memory/archive";
import { NonRetryableJobError } from "../../lib/dbq/runner";
import { memberDataActionAllowed } from "../../modules/orgs/orgs.service";
import {
    JsonExportType,
    MAX_ZIP_EXPORT_DOCUMENTS,
    ExportType,
    EXPORT_TYPES,
    isWorkspaceExportType,
} from "./exportContracts";
/** One finished artifact, ready to park in storage. */
type ExportArtifact = {
    body: Buffer;
    filename: string;
    /** Stored on the object and replayed as the download's Content-Type. */
    contentType: string;
};
const JSON_EXPORT_AUDIT_ACTIONS: Record<JsonExportType, string> = {
    account: "export.account",
    chats: "export.chats",
    "tabular-reviews": "export.tabular",
};
async function buildJsonExport(
    db: Db,
    userId: string,
    userEmail: string | null,
    type: JsonExportType,
    orgId: string | null,
): Promise<ExportArtifact> {
    const data =
        type === "account"
            ? await buildUserAccountExport(db, userId, userEmail, orgId)
            : type === "chats"
              ? await buildUserChatsExport(db, userId, userEmail, orgId)
              : await buildUserTabularReviewsExport(db, userId, userEmail, orgId);
    return {
        body: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
        filename: userExportFilename(type, userId, orgId),
        contentType: "application/json",
    };
}
async function buildAuditCsvExport(db: Db, job: ExportBuildRequest, userId: string, userEmail: string | null): Promise<ExportArtifact> {
    // The route validated these params through parseQuery before enqueuing,
    // so a job without them is malformed rather than retryable.
    const query = job.payload.query as AuditQuery | undefined;
    if (!query || typeof query !== "object") {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    const csv = await buildAuditCsv(db, userId, userEmail ?? undefined, query);
    return {
        body: Buffer.from(csv, "utf8"),
        filename: query.orgId ? "organization-audit.csv" : AUDIT_CSV_FILENAME,
        contentType: "text/csv; charset=utf-8",
    };
}
async function buildDocumentsZipExport(db: Db, job: ExportBuildRequest, userId: string, userEmail: string | null): Promise<ExportArtifact> {
    const documentIds = job.payload.document_ids as unknown;
    if (!Array.isArray(documentIds) ||
        documentIds.length === 0 ||
        documentIds.length > MAX_ZIP_EXPORT_DOCUMENTS ||
        documentIds.some((id) => typeof id !== "string" || !id)) {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    // org_id and workflow_id are part of the verdict, not decoration:
    // ensureDocAccess resolves a workflow asset through its workflow and an
    // org document through its org. Selecting only project_id/user_id made
    // both branches unreachable, so an org colleague's document and every
    // detached document were silently dropped from the zip. The sync route
    // already selects the full set.
    const { data: rawDocs, error } = await db
        .from("documents")
        .select("id, current_version_id, user_id, project_id, org_id, workflow_id")
        .in("id", documentIds as string[]);
    if (error)
        throw new Error(`[export.build] ${error.message}`);
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    let added = 0;
    for (const doc of (rawDocs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
        org_id?: string | null;
        workflow_id?: string | null;
    }[]) {
        // Access is re-checked HERE, not at enqueue time: the payload's ids
        // are stale by definition (a share can be revoked while the job
        // waits), so a doc the user can no longer read is skipped.
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok)
            continue;
        const active = await loadActiveVersion(doc.id, db);
        if (!active)
            continue;
        const raw = await downloadFile(active.storage_path);
        if (!raw)
            continue;
        // Sequential, unlike the sync route's Promise.all: this path exists
        // for selections large enough that fetching every file at once is
        // what would blow the memory ceiling.
        zip.file(downloadFilenameForVersion(active.filename, active.version_number, active.source === "assistant_edit"), Buffer.from(raw));
        added++;
    }
    if (added === 0) {
        throw new Error(`[export.build] no accessible documents for job ${job.id}`);
    }
    return {
        body: await zip.generateAsync({
            type: "nodebuffer",
            compression: "DEFLATE",
        }),
        filename: "documents.zip",
        contentType: "application/zip",
    };
}
async function buildMemoryZipExport(
    db: Db,
    userId: string,
    userEmail: string | null,
    orgId: string | null,
): Promise<ExportArtifact> {
    return {
        body: await buildMemoryArchive(db, userId, userEmail, orgId),
        filename: orgId
            ? `mike-memory-export-${orgId.slice(0, 8)}.zip`
            : "mike-memory-export.zip",
        contentType: "application/zip",
    };
}
export async function buildExport(db: Db, job: ExportBuildRequest): Promise<Record<string, unknown>> {
    const userId = job.payload.userId as string | undefined;
    const type = job.payload.type as ExportType | undefined;
    if (!userId || !type || !EXPORT_TYPES.includes(type)) {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    const userEmail = (job.payload.userEmail as string | undefined) ?? null;
    // The workspace a Settings export covers. A job queued before exports
    // had one carries none and is built as Personal, never as every
    // workspace.
    const orgId = typeof job.payload.orgId === "string" ? job.payload.orgId : null;
    // Checked again now: membership, or the organization's policy, may have
    // changed while the job waited.
    if (orgId &&
        isWorkspaceExportType(type) &&
        !(await memberDataActionAllowed(db, userId, orgId, "export"))) {
        throw new NonRetryableJobError(`[export.build] exports are not allowed for this member in ${orgId}`);
    }
    const artifact = type === "audit-csv"
        ? await buildAuditCsvExport(db, job, userId, userEmail)
        : type === "documents-zip"
            ? await buildDocumentsZipExport(db, job, userId, userEmail)
            : type === "memory-zip"
                ? await buildMemoryZipExport(db, userId, userEmail, orgId)
                : await buildJsonExport(db, userId, userEmail, type, orgId);
    // Path is namespaced under the user (account erasure purges the prefix)
    // and keyed by job id (a re-run overwrites its own artifact — idempotent).
    const storagePath = `exports/${userId}/${job.id}-${artifact.filename}`;
    const body = artifact.body;
    await uploadFile(storagePath, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer, artifact.contentType);
    // The completion audit row replaces the one the old sync route wrote.
    // The filtered exports have no such row: neither of their sync routes
    // recorded one, and inventing it here would change the history feed.
    if (type === "memory-zip") {
        await recordAudit(db, {
            userId,
            userEmail,
            action: "export.memory",
            surface: "account",
        });
    }
    else if (type !== "audit-csv" && type !== "documents-zip") {
        await recordAudit(db, {
            userId,
            userEmail,
            action: JSON_EXPORT_AUDIT_ACTIONS[type],
            surface: "account",
        });
    }
    // No signed /download token here: that route only serves paths backed by
    // a live document_versions row, which an export artifact is not. The
    // client downloads through GET /user/exports/:id/download instead, which
    // re-checks ownership on every request and replays content_type.
    return {
        storage_path: storagePath,
        filename: artifact.filename,
        content_type: artifact.contentType,
    };
}
