// exportJobs — implementation behind the module facade.
// Handlers for the DB queue. Every handler runs with at-least-once
// semantics: it must be idempotent, and it signals "retry me" by throwing.
//
// Registered kinds:
//   audit.chat_turn  — fan out one chat turn's audit rows (durable audit)
//   account.delete   — full account data erasure (survives restarts)
//   storage.cleanup  — delete storage objects/prefixes (no more swallowed
//                      fire-and-forget deletes leaking files)
//   export.build     — build a user data export and park it in storage
//   mcp.refresh_token        — renew an MCP OAuth access token before it
//                      expires, instead of on the request that needs it
//   document.precompute_text — extract a legacy Office file's text once, so
//                      read_document stops paying for LibreOffice per call
//   memory.consolidate — curate scoped Markdown after chat inactivity
import { recordAudit } from "../../lib/audit";
import { buildUserAccountExport, buildUserChatsExport, buildUserTabularReviewsExport, userExportFilename } from "./user.dataExport";
import { AUDIT_CSV_FILENAME, buildAuditCsv, type AuditQuery } from "../../lib/auditExport";
import { ensureDocAccess } from "../../lib/access";
import { downloadFilenameForVersion, loadActiveVersion } from "../../lib/documentVersions";
import { downloadFile, uploadFile } from "../../lib/storage";
import { type Db, type DbJob } from "../../lib/dbq/types";
import { buildMemoryArchive } from "../../lib/memory/archive";
import { JsonExportType, MAX_ZIP_EXPORT_DOCUMENTS, ExportType, EXPORT_TYPES } from "./user.exportContracts";

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
): Promise<ExportArtifact> {
    const data =
        type === "account"
            ? await buildUserAccountExport(db, userId, userEmail)
            : type === "chats"
              ? await buildUserChatsExport(db, userId, userEmail)
              : await buildUserTabularReviewsExport(db, userId, userEmail);
    return {
        body: Buffer.from(JSON.stringify(data, null, 2), "utf8"),
        filename: userExportFilename(type, userId),
        contentType: "application/json",
    };
}

async function buildAuditCsvExport(
    db: Db,
    job: DbJob,
    userId: string,
    userEmail: string | null,
): Promise<ExportArtifact> {
    // The route validated these params through parseQuery before enqueuing,
    // so a job without them is malformed rather than retryable.
    const query = job.payload.query as AuditQuery | undefined;
    if (!query || typeof query !== "object") {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    const csv = await buildAuditCsv(db, userId, userEmail ?? undefined, query);
    return {
        body: Buffer.from(csv, "utf8"),
        filename: AUDIT_CSV_FILENAME,
        contentType: "text/csv; charset=utf-8",
    };
}

async function buildDocumentsZipExport(
    db: Db,
    job: DbJob,
    userId: string,
    userEmail: string | null,
): Promise<ExportArtifact> {
    const documentIds = job.payload.document_ids as unknown;
    if (
        !Array.isArray(documentIds) ||
        documentIds.length === 0 ||
        documentIds.length > MAX_ZIP_EXPORT_DOCUMENTS ||
        documentIds.some((id) => typeof id !== "string" || !id)
    ) {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }

    const { data: rawDocs, error } = await db
        .from("documents")
        .select("id, current_version_id, user_id, project_id")
        .in("id", documentIds as string[]);
    if (error) throw new Error(`[export.build] ${error.message}`);

    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    let added = 0;
    for (const doc of (rawDocs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
    }[]) {
        // Access is re-checked HERE, not at enqueue time: the payload's ids
        // are stale by definition (a share can be revoked while the job
        // waits), so a doc the user can no longer read is skipped.
        const access = await ensureDocAccess(doc, userId, userEmail, db);
        if (!access.ok) continue;
        const active = await loadActiveVersion(doc.id, db);
        if (!active) continue;
        const raw = await downloadFile(active.storage_path);
        if (!raw) continue;
        // Sequential, unlike the sync route's Promise.all: this path exists
        // for selections large enough that fetching every file at once is
        // what would blow the memory ceiling.
        zip.file(
            downloadFilenameForVersion(
                active.filename,
                active.version_number,
                active.source === "assistant_edit",
            ),
            Buffer.from(raw),
        );
        added++;
    }
    if (added === 0) {
        throw new Error(
            `[export.build] no accessible documents for job ${job.id}`,
        );
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
): Promise<ExportArtifact> {
    return {
        body: await buildMemoryArchive(db, userId, userEmail),
        filename: "mike-memory-export.zip",
        contentType: "application/zip",
    };
}

export async function handleExportBuild(
    db: Db,
    job: DbJob,
): Promise<Record<string, unknown>> {
    const userId = job.payload.userId as string | undefined;
    const type = job.payload.type as ExportType | undefined;
    if (!userId || !type || !EXPORT_TYPES.includes(type)) {
        throw new Error(`[export.build] malformed payload on job ${job.id}`);
    }
    const userEmail = (job.payload.userEmail as string | undefined) ?? null;

    const artifact =
        type === "audit-csv"
            ? await buildAuditCsvExport(db, job, userId, userEmail)
            : type === "documents-zip"
              ? await buildDocumentsZipExport(db, job, userId, userEmail)
              : type === "memory-zip"
                ? await buildMemoryZipExport(db, userId, userEmail)
              : await buildJsonExport(db, userId, userEmail, type);

    // Path is namespaced under the user (account erasure purges the prefix)
    // and keyed by job id (a re-run overwrites its own artifact — idempotent).
    const storagePath = `exports/${userId}/${job.id}-${artifact.filename}`;
    const body = artifact.body;
    await uploadFile(
        storagePath,
        body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
        ) as ArrayBuffer,
        artifact.contentType,
    );

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
    } else if (type !== "audit-csv" && type !== "documents-zip") {
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
