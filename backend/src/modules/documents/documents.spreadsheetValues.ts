// Source-bound values previews. No signed URLs, persistent derived content or
// storage writes: every read authorizes the document where it lives now.
import type { SpreadsheetValuesPreview } from "@mike/contracts";
import type { Db } from "../../lib/supabase";
import type { Readable } from "node:stream";
import { isUuid } from "../../lib/uuid";
import { contentSha256 } from "../../lib/documentVersions";
import { createFileReadStream, headFile } from "../../lib/storage";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import { withExtractionRequest, ExtractionBusyError, ExtractionLimitError } from "../../lib/extraction/isolated";
import { SpreadsheetValuesError, SPREADSHEET_VALUES_MAX_BYTES } from "../../lib/extraction/limits";
import { ensureDocumentAccess } from "./documents.access";

type Args = { documentId: string; userId: string; userEmail?: string; versionId?: string | null; signal?: AbortSignal };
type Checkpoint = { versionId: string; storagePath: string; filename: string; hash: string | null };
const absent = () => failure("not_found", "Document not found");
const changed = () => failure("conflict", "The source changed. Reload the preview before continuing.", "spreadsheet_values_changed");
class SourceChangedError extends Error {}

async function checkpoint(db: Db, args: Args): Promise<ServiceResult<Checkpoint>> {
    const access = await ensureDocumentAccess(args.documentId, args.userId, args.userEmail, db, {
        select: "id, user_id, project_id, org_id, workflow_id, current_version_id, archived_at",
    });
    if (!access.ok) return access.kind === "error" ? internalFailure(access.error) : absent();
    const versionId = args.versionId || access.doc.current_version_id;
    if (!versionId) return absent();
    // An explicit version can never fall back to the active version or a row
    // belonging to another document, even when the caller can read both.
    const { data: row, error } = await db.from("document_versions")
        .select("id, storage_path, filename, file_type, content_sha256")
        .eq("id", versionId).eq("document_id", args.documentId).is("deleted_at", null).maybeSingle();
    if (error) return internalFailure(error);
    if (!row || !row.storage_path) return absent();
    if (!["xls", "xlsx", "xlsm"].includes(row.file_type ?? "")) {
        return failure("validation", "This preview only accepts BIFF8 spreadsheets.", "spreadsheet_values_unsupported");
    }
    return ok({ versionId: row.id, storagePath: row.storage_path,
        filename: row.filename || "Spreadsheet.xls", hash: row.content_sha256 ?? null });
}

async function recheck(db: Db, args: Args, source: Checkpoint): Promise<ServiceResult<Checkpoint>> {
    const result = await checkpoint(db, { ...args, versionId: source.versionId });
    if (!result.ok) return result;
    if (result.data.storagePath !== source.storagePath || result.data.hash !== source.hash) return changed();
    return result;
}

async function readBytes(source: Checkpoint, signal?: AbortSignal): Promise<ArrayBuffer> {
    let stream: Readable | undefined;
    let stopped = false;
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const stop = () => {
        stopped = true;
        const error = new Error("Spreadsheet source read interrupted");
        stream?.destroy(error); rejectDeadline(error);
    };
    const timer = setTimeout(stop, 15_000);
    signal?.addEventListener("abort", stop, { once: true });
    const read = async () => {
        if (stopped || signal?.aborted) throw new Error("Spreadsheet request cancelled");
        const metadata = await headFile(source.storagePath);
        if (stopped || signal?.aborted) throw new Error("Spreadsheet request cancelled");
        if (!metadata) throw new Error("Spreadsheet source unavailable");
        if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > SPREADSHEET_VALUES_MAX_BYTES) {
            throw new SpreadsheetValuesError("spreadsheet_values_limit");
        }
        stream = createFileReadStream(source.storagePath);
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += bytes.length;
            if (size > SPREADSHEET_VALUES_MAX_BYTES) throw new SpreadsheetValuesError("spreadsheet_values_limit");
            chunks.push(bytes);
        }
        if (size !== metadata.size) throw new SourceChangedError();
        const buffer = Buffer.concat(chunks, size);
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    };
    try {
        return await Promise.race([read(), deadline]);
    } finally {
        clearTimeout(timer); signal?.removeEventListener("abort", stop); stream?.destroy();
    }
}

function mapError(error: unknown) {
    if (error instanceof SourceChangedError) return changed();
    if (error instanceof SpreadsheetValuesError) {
        return failure(error.code === "spreadsheet_values_unavailable" ? "unavailable" : "validation", error.message, error.code);
    }
    if (error instanceof ExtractionBusyError) return failure("unavailable", "The parser is busy. Try again shortly.", "spreadsheet_values_busy");
    if (error instanceof ExtractionLimitError) return failure("validation", "The preview exceeded its resource limit. Download the original.", "spreadsheet_values_limit");
    return internalFailure(error);
}

export async function getSpreadsheetValuesPreview(db: Db, args: Args): Promise<ServiceResult<SpreadsheetValuesPreview>> {
    if (!isUuid(args.documentId) || args.versionId != null && !isUuid(args.versionId)) return absent();
    if (process.env.EXTRACTION_ISOLATION === "off") {
        return failure("unavailable", "Spreadsheet values preview requires an isolated parser.", "spreadsheet_values_unavailable");
    }
    try {
        return await withExtractionRequest(async extract => {
            const loaded = await checkpoint(db, args); if (!loaded.ok) return loaded;
            const source = loaded.data;
            const bytes = await readBytes(source, args.signal);
            if (args.signal?.aborted) throw new Error("Spreadsheet request cancelled");
            const hash = contentSha256(bytes);
            if (source.hash && source.hash !== hash) return changed();
            const values = await extract("spreadsheetValues", bytes);
            if (args.signal?.aborted) throw new Error("Spreadsheet request cancelled");
            const current = await recheck(db, args, source); if (!current.ok) return current;
            return ok({ source: { documentId: args.documentId, versionId: source.versionId,
                filename: current.data.filename, sha256: hash, bytes: bytes.byteLength }, values });
        });
    } catch (error) { return mapError(error); }
}

/** Download only the exact bytes that produced the displayed preview, including
 * versions that upstream permits to be overwritten in place. Reauthorizing and
 * hashing again prevents an old checkpoint silently downloading newer content.
 */
export async function getSpreadsheetValuesSource(db: Db, args: Args & { sha256: string }): Promise<ServiceResult<{ bytes: ArrayBuffer; filename: string }>> {
    if (!isUuid(args.documentId) || !args.versionId || !isUuid(args.versionId) || !/^[a-f0-9]{64}$/.test(args.sha256)) return absent();
    try {
        return await withExtractionRequest(async () => {
            const loaded = await checkpoint(db, args); if (!loaded.ok) return loaded;
            const bytes = await readBytes(loaded.data, args.signal);
            const hash = contentSha256(bytes);
            if (hash !== args.sha256 || loaded.data.hash && loaded.data.hash !== hash) return changed();
            const current = await recheck(db, args, loaded.data); if (!current.ok) return current;
            if (args.signal?.aborted) throw new Error("Spreadsheet request cancelled");
            return ok({ bytes, filename: current.data.filename });
        });
    } catch (error) { return mapError(error); }
}
