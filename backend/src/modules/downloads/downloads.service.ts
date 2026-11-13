// Business logic + data-access for the downloads module.
//
// Service layer behind downloads.routes.ts. Takes an explicit Supabase client
// (`db`) plus request-derived primitives, resolves a signed download token to
// the object it grants access to, and RETURNS a typed result. It never touches
// req/res — the route maps the result onto status codes, headers, and body.

import type { Db } from "../../lib/supabase";
import type { Readable } from "node:stream";
import {
    BlobUploadSizeError,
    headFile,
    openFileStream,
    writeBlobFromStream,
} from "../../lib/storage";
import {
    verifyBlobToken,
    verifyBlobUploadToken,
    verifyDownload,
} from "../../lib/downloadTokens";
import {
    failure,
    internalFailure,
    ok,
    type ServiceResult,
} from "../../lib/serviceResult";
import { ensureDocAccess } from "../../lib/access";
import {
    contentTypeForDocumentType,
    documentSuffix,
} from "../../lib/documentTypes";

function contentTypeFor(filename: string): string {
    return contentTypeForDocumentType(documentSuffix(filename));
}

/**
 * An object a download token resolved to: what the response headers need,
 * and a way to open the bytes. Opening is deferred so a conditional or HEAD
 * request can be answered from the metadata without reading the object.
 */
export type ObjectDownload = {
    size: number;
    etag: string | null;
    contentType: string;
    filename: string;
    /**
     * Open the object as a stream. Rejects (StorageOperationError) when the
     * store cannot serve it, before any byte is produced; `signal` releases
     * the read when the client goes away.
     */
    open: (signal: AbortSignal) => Promise<Readable>;
};

/**
 * Metadata for the object at `path`, or null when it is not there. A HEAD,
 * not a read: the bytes are streamed to the client later, never held whole.
 */
async function describeObject(
    path: string,
    filename: string,
): Promise<ObjectDownload | null> {
    const head = await headFile(path);
    if (!head) return null;
    return {
        size: head.size,
        etag: head.etag,
        contentType: contentTypeFor(filename),
        filename,
        open: (signal) => openFileStream(path, { signal }),
    };
}

/**
 * Resolve a filesystem-driver blob token (the fs stand-in for an S3 presigned
 * GET) to the object it names. The token itself is the authorization: it is
 * minted only after an authenticated caller's access check, matching the S3
 * presigned URLs used by the cloud storage driver.
 */
export async function resolveBlobDownload(
    token: string,
): Promise<ServiceResult<ObjectDownload>> {
    const info = verifyBlobToken(token);
    if (!info) return failure("not_found", "Invalid or expired link");
    const download = await describeObject(info.path, info.filename);
    if (!download) return failure("not_found", "File not found");
    return ok(download);
}

/**
 * Redeem a filesystem-driver upload token (the fs stand-in for an S3 presigned
 * PUT) by streaming the request body to disk.
 *
 * The declared content type and byte count are inside the signature, so an
 * oversized or mistyped body is rejected and the partial file removed, which
 * is how the S3 URL behaves (S3 fails signature validation on a Content-Length
 * that differs from the signed one).
 */
export async function storeBlobUpload(args: {
    token: string;
    contentType: string;
    body: Readable;
}): Promise<ServiceResult<void>> {
    const info = verifyBlobUploadToken(args.token);
    if (!info) return failure("forbidden", "Invalid or expired upload link");
    const declaredType = args.contentType.split(";")[0].trim();
    if (declaredType && declaredType !== info.contentType) {
        return failure("validation", "Upload content type does not match the link");
    }
    try {
        await writeBlobFromStream(info.path, args.body, info.sizeBytes);
    } catch (error) {
        // writeBlobFromStream commits only on success, so a failed upload
        // leaves no partial file and any existing blob at the key intact.
        if (error instanceof BlobUploadSizeError) {
            return failure("validation", "Upload size does not match the link");
        }
        return internalFailure(error);
    }
    return ok(undefined);
}

/**
 * Resolve a signed download token to the object it names, enforcing that the token's
 * storage path is still backed by a live document version the caller can
 * access. Every failure after token verification collapses to "not_found" so
 * a valid-looking token cannot be used to probe for foreign files.
 */
export async function resolveTokenDownload(
    db: Db,
    args: { token: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; download: ObjectDownload }
    | { ok: false; kind: "invalid_link" | "not_found" }
> {
    const info = verifyDownload(args.token);
    if (!info) return { ok: false, kind: "invalid_link" };

    const { data: version } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", info.path)
        .is("deleted_at", null)
        .maybeSingle();
    if (!version) return { ok: false, kind: "not_found" };

    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id, org_id, workflow_id")
        .eq("id", (version as { document_id: string }).document_id)
        .single();
    if (!doc) return { ok: false, kind: "not_found" };

    const access = await ensureDocAccess(doc, args.userId, args.userEmail, db);
    if (!access.ok) return { ok: false, kind: "not_found" };

    const download = await describeObject(info.path, info.filename);
    if (!download) return { ok: false, kind: "not_found" };
    return { ok: true, download };
}
