import { createHash } from "node:crypto";
import type { Db } from "./supabase";

type Supa = Db;

/**
 * SHA-256 hex digest of a version's file bytes. Stored on
 * `document_versions.content_sha256` at write time so an export manifest can
 * prove a file matches the bytes the workspace held. Recompute whenever the
 * stored bytes change — a new version row, or an in-place overwrite.
 *
 * Accepts a typed-array view as well as a raw ArrayBuffer;
 * several call sites pass views into a larger backing buffer, so the offset
 * and length must be respected rather than hashing the whole buffer.
 */
export function contentSha256(bytes: ArrayBuffer | ArrayBufferView): string {
    const buf = ArrayBuffer.isView(bytes)
        ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : Buffer.from(bytes);
    return createHash("sha256").update(buf).digest("hex");
}

interface DocRow {
    id: string;
    latest_version_number?: number | null;
    [k: string]: unknown;
}

interface VersionPathRow extends DocRow {
    /** API/client alias for document_versions.filename of the active version. */
    filename?: string | null;
    /** Set from document_versions.storage_path of the active version. */
    storage_path?: string | null;
    /** Set from document_versions.pdf_storage_path of the active version. */
    pdf_storage_path?: string | null;
    current_version_id?: string | null;
    /** Set from document_versions.version_number of the active version. */
    active_version_number?: number | null;
    /** Active-version file metadata. */
    source?: string | null;
    file_type?: string | null;
    size_bytes?: number | null;
    page_count?: number | null;
}

export interface ActiveVersion {
    id: string;
    storage_path: string;
    pdf_storage_path: string | null;
    version_number: number | null;
    filename: string | null;
    source: string | null;
    file_type: string | null;
    size_bytes: number | null;
    page_count: number | null;
}

/**
 * Resolve storage paths for a document. Prefers the version pointed to by
 * `versionId` (if it belongs to this document); else falls back to
 * `documents.current_version_id`. Returns null if no usable version exists.
 *
 * After the storage_path/pdf_storage_path columns moved off `documents`,
 * every read-from-storage path goes through here.
 */
export async function loadActiveVersion(
    documentId: string,
    db: Supa,
    versionId?: string | null,
): Promise<ActiveVersion | null> {
    const { data: doc } = await db
        .from("documents")
        .select("current_version_id")
        .eq("id", documentId)
        .single();
    const targetVersionId =
        (typeof versionId === "string" && versionId) ||
        (doc?.current_version_id as string | undefined) ||
        null;
    if (!targetVersionId) return null;

    const { data: v } = await db
        .from("document_versions")
        .select(
            "id, document_id, storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count",
        )
        .eq("id", targetVersionId)
        .is("deleted_at", null)
        .single();
    if (!v || v.document_id !== documentId || !v.storage_path) return null;
    return {
        id: v.id as string,
        storage_path: v.storage_path as string,
        pdf_storage_path: (v.pdf_storage_path as string | null) ?? null,
        version_number: (v.version_number as number | null) ?? null,
        filename: (v.filename as string | null) ?? null,
        source: (v.source as string | null) ?? null,
        file_type: (v.file_type as string | null) ?? null,
        size_bytes: (v.size_bytes as number | null) ?? null,
        page_count: (v.page_count as number | null) ?? null,
    };
}

/**
 * Produce the filename a download should present to the user. Version
 * filenames are expected to include the real extension.
 *
 * Shared by the download routes and the "documents-zip" export job, which
 * must name the entries in the zip exactly as the sync route does.
 */
export function downloadFilenameForVersion(
    filename: string | null | undefined,
    versionNumber: number | null,
    edited = false,
): string {
    const resolved = filename?.trim() || "Untitled document.docx";
    if (!edited || !versionNumber || versionNumber < 1) return resolved;
    const dot = resolved.lastIndexOf(".");
    const stem = dot > 0 ? resolved.slice(0, dot) : resolved;
    const ext = dot > 0 ? resolved.slice(dot) : "";
    return `${stem} [Edited V${versionNumber}]${ext}`;
}

/**
 * For a list of documents, look up the active version for each and merge
 * `storage_path` + `pdf_storage_path` onto the row. One round-trip total
 * regardless of list size. Documents with no current_version_id retain
 * null paths.
 */
export async function attachActiveVersionPaths<T extends VersionPathRow>(
    db: Supa,
    docs: T[],
): Promise<T[]> {
    if (docs.length === 0) return docs;
    const versionIds = docs
        .map((d) => d.current_version_id)
        .filter((id): id is string => typeof id === "string");
    if (versionIds.length === 0) {
        for (const d of docs) {
            d.filename = "Untitled document";
            d.storage_path = null;
            d.pdf_storage_path = null;
            d.source = null;
            d.file_type = null;
            d.size_bytes = null;
            d.page_count = null;
        }
        return docs;
    }
    const { data: rows } = await db
        .from("document_versions")
        .select(
            "id, storage_path, pdf_storage_path, version_number, filename, source, file_type, size_bytes, page_count",
        )
        .in("id", versionIds)
        .is("deleted_at", null);
    const byId = new Map<
        string,
        {
            storage_path: string | null;
            pdf_storage_path: string | null;
            version_number: number | null;
            filename: string | null;
            source: string | null;
            file_type: string | null;
            size_bytes: number | null;
            page_count: number | null;
        }
    >();
    for (const r of (rows ?? []) as {
        id: string;
        storage_path: string | null;
        pdf_storage_path: string | null;
        version_number: number | null;
        filename: string | null;
        source: string | null;
        file_type: string | null;
        size_bytes: number | null;
        page_count: number | null;
    }[]) {
        byId.set(r.id, {
            storage_path: r.storage_path ?? null,
            pdf_storage_path: r.pdf_storage_path ?? null,
            version_number: r.version_number ?? null,
            filename: r.filename ?? null,
            source: r.source ?? null,
            file_type: r.file_type ?? null,
            size_bytes: r.size_bytes ?? null,
            page_count: r.page_count ?? null,
        });
    }
    for (const d of docs) {
        const v = d.current_version_id ? byId.get(d.current_version_id) : null;
        d.storage_path = v?.storage_path ?? null;
        d.pdf_storage_path = v?.pdf_storage_path ?? null;
        d.active_version_number = v?.version_number ?? null;
        d.filename = v?.filename?.trim() || "Untitled document";
        d.source = v?.source ?? null;
        d.file_type = v?.file_type ?? null;
        d.size_bytes = v?.size_bytes ?? null;
        d.page_count = v?.page_count ?? null;
    }
    return docs;
}

/**
 * Given a list of document rows, attach `latest_version_number` — the
 * max `version_number` across all assistant_edit rows for that doc, or
 * null if none. Mutates rows in place and returns the same reference.
 * One extra query regardless of list size.
 */
export async function attachLatestVersionNumbers<T extends DocRow>(
    db: Supa,
    docs: T[],
): Promise<T[]> {
    if (docs.length === 0) return docs;
    const ids = docs.map((d) => d.id);
    const { data: rows } = await db
        .from("document_versions")
        .select("document_id, version_number")
        .in("document_id", ids)
        .eq("source", "assistant_edit")
        .is("deleted_at", null)
        .not("version_number", "is", null);

    const latestByDoc = new Map<string, number>();
    for (const r of (rows ?? []) as {
        document_id: string;
        version_number: number | null;
    }[]) {
        if (r.version_number == null) continue;
        const prev = latestByDoc.get(r.document_id) ?? 0;
        if (r.version_number > prev)
            latestByDoc.set(r.document_id, r.version_number);
    }
    for (const d of docs) {
        d.latest_version_number = latestByDoc.get(d.id) ?? null;
    }
    return docs;
}
