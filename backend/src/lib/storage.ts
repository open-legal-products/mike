/**
 * Object storage facade for Mike document management.
 *
 * The transport lives behind the StorageAdapter interface
 * (./storage/adapter.ts); the default is the S3-protocol adapter
 * (./storage/s3.ts — Cloudflare R2, RustFS, MinIO). This module owns the
 * policy every backend shares: not-configured degradation (reads return
 * null/empty, writes throw), error logging, StorageOperationError wrapping,
 * Content-Disposition building, and the storage-key layout.
 *
 * Deployments on a different object store implement StorageAdapter in one
 * file and call setStorageAdapter() at boot; no call sites change.
 */

import { AppError, type ErrorKind } from "./appError";
import { bestEffort } from "./observability/sentry";
import { Readable } from "node:stream";
import type {
  StorageAdapter,
  StoredObjectMetadata,
} from "./storage/adapter";
import { createS3StorageAdapter } from "./storage/s3";
import { createFilesystemStorageAdapter } from "./storage/filesystem";
import { buildContentDisposition } from "./storage/filenames";
export { BlobUploadSizeError } from "./storage/filesystem";
export {
  buildContentDisposition,
  encodeRFC5987,
  normalizeDownloadFilename,
  sanitizeDispositionFilename,
} from "./storage/filenames";

export type { StorageAdapter, StoredObjectMetadata } from "./storage/adapter";

let adapter: StorageAdapter = process.env.STORAGE_DRIVER === "fs"
  ? createFilesystemStorageAdapter()
  : createS3StorageAdapter();

export let storageEnabled = adapter.enabled;

/** Replace the storage backend. Call before the first request is served. */
export function setStorageAdapter(next: StorageAdapter): void {
  adapter = next;
  storageEnabled = next.enabled;
}

const STORAGE_FAILURE_KIND = {
  HEAD: "storage.head_failed",
  copy: "storage.copy_failed",
  upload: "storage.upload_failed",
  download: "storage.download_failed",
  delete: "storage.delete_failed",
} as const satisfies Record<string, ErrorKind>;

export type StorageOperation = keyof typeof STORAGE_FAILURE_KIND;

/**
 * One object-storage call failed. The operation is the kind (one issue per
 * operation), the adapter's own error is the cause (its AWS/system code
 * reaches Sentry as `failure_code`); the key never leaves the process.
 */
export class StorageOperationError extends AppError {
  constructor(readonly operation: StorageOperation, options?: { cause?: unknown }) {
    super(STORAGE_FAILURE_KIND[operation], `Object storage ${operation} failed`, options);
  }
}

/**
 * A storage failure this facade absorbs: the caller gets null, as it does
 * when storage is not configured, so nothing above reports it. Report it
 * here, once, with the operation (and the SDK's code via the cause) on the
 * event, then log the SAME object: the console bridge recognises a reported
 * error and files no second, context-free "Failure in application".
 */
function requireStorageConfig(): void {
  if (!adapter.enabled) {
    throw new Error(adapter.configurationHint);
  }
}

/**
 * Fail closed for workflows where treating an unconfigured object store as an
 * empty/successful operation would discard the only durable deletion pointer.
 */
export function assertStorageConfigured(): void {
  requireStorageConfig();
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  await adapter.uploadFile(key, content, contentType);
}

export async function uploadFileFromPath(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  try {
    await adapter.uploadFileFromPath(key, filePath, contentType);
  } catch (error) {
    throw new StorageOperationError("upload", { cause: error });
  }
}

/**
 * Presign a single direct browser `PUT`. The declared content type and byte
 * count are part of the signature, so the URL cannot be replayed with a
 * different body: the browser sets `Content-Length` from the body itself, and
 * any other size fails signature validation at the store.
 */
export async function getSignedUploadUrl(
  key: string,
  contentType: string,
  expectedSizeBytes: number,
  expiresIn = 900,
): Promise<string | null> {
  if (!adapter.enabled) return null;
  try {
    return await adapter.getSignedUploadUrl(
      key,
      contentType,
      expectedSizeBytes,
      expiresIn,
    );
  } catch (error) {
    // Thrown once with the SDK's own code on the cause; the route that
    // answers reports it. Logging and returning null here filed the failure
    // twice: once from storage, once from the caller's cause-less throw.
    throw new AppError(
      "storage.signed_url_failed",
      "Object storage signed upload URL failed",
      { cause: error },
    );
  }
}

export async function headFile(
  key: string,
): Promise<StoredObjectMetadata | null> {
  if (!adapter.enabled) return null;
  try {
    return await adapter.headFile(key);
  } catch (error) {
    // Thrown, not logged: the caller that catches this reports it, and a
    // console line here filed the same failure a second time.
    throw new StorageOperationError("HEAD", { cause: error });
  }
}

export async function copyFile(
  sourceKey: string,
  targetKey: string,
): Promise<void> {
  requireStorageConfig();
  try {
    await adapter.copyFile(sourceKey, targetKey);
  } catch (error) {
    throw new StorageOperationError("copy", { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!adapter.enabled) return null;
  try {
    return await adapter.downloadFile(key);
  } catch (error) {
    // null is "not there" (the adapters translate a missing object); a
    // transport or permission failure is thrown so the caller's handler
    // reports it once, with the store's own code on the cause.
    throw new StorageOperationError("download", { cause: error });
  }
}

/**
 * Read an object the caller can go on without: a cached rendition, an
 * optional PDF copy, a fallback source. null for an object that is not
 * there, and null for a failure too, which is reported once here as a
 * warning with the store's code, because the caller will carry on and
 * nothing else would file it. A read the caller cannot do without uses
 * downloadFile, whose failure propagates to the handler that reports it.
 */
export async function downloadFileIfAvailable(
  key: string,
): Promise<ArrayBuffer | null> {
  return (await bestEffort(downloadFile(key), { what: "optional-read" })) ?? null;
}

/**
 * Lazily stream an object from the store. The read starts only when a consumer
 * reads from the returned stream, allowing archive writers to apply
 * backpressure without buffering whole files or opening every object
 * concurrently.
 */
export function createFileReadStream(key: string): Readable {
  return Readable.from(
    (async function* () {
      requireStorageConfig();
      try {
        const body = await adapter.openReadStream(key);
        if (!body) {
          throw new StorageOperationError("download");
        }
        for await (const chunk of body) {
          yield chunk;
        }
      } catch (error) {
        // Thrown, not logged (see headFile).
        if (error instanceof StorageOperationError) throw error;
        throw new StorageOperationError("download", { cause: error });
      }
    })(),
  );
}

export async function listFiles(prefix: string): Promise<string[]> {
  if (!adapter.enabled) return [];
  return adapter.listFiles(prefix);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!adapter.enabled) return;
  // An empty key names no object. Sent anyway, the SDK either rejects it
  // (a missing URI label) or, on some stores, addresses the bucket itself.
  if (!key) return;
  try {
    // The adapter resolves when the store itself says the object is already
    // gone (see deleteFile in ./storage/adapter.ts), so reaching this catch
    // means the delete genuinely failed.
    await adapter.deleteFile(key);
  } catch (error) {
    // Same shape as HEAD/copy/download failures: the operation is named and
    // the SDK error (with its errno or S3 code) is the cause, which is where
    // the Sentry privacy boundary reads storage_operation and failure_code.
    throw new StorageOperationError("delete", { cause: error });
  }
}

/**
 * Delete an object the caller can live without but must not leak (a
 * rollback, a cancelled upload's staging blob). A failure here is not the
 * caller's failure, so instead of `.catch(() => {})` it is reported as a
 * warning grouped by `stage`. The key never goes on the event: keys embed
 * the user's original filename.
 */
export function deleteFileBestEffort(
  key: string,
  stage: string,
): Promise<void | undefined> {
  return deleteFilesBestEffort([key], stage);
}

/**
 * Best-effort delete of several objects that belong to ONE operation (an
 * upload's staging and sealed copies). Every key is attempted, but the
 * operation reports at most one warning: when storage is unreachable or the
 * credentials are wrong, every key fails for the same reason, and one event
 * per key only multiplies the noise (MIKE-BACKEND-5/6 arrived in pairs).
 * Null/empty keys are skipped: there is nothing to delete.
 */
export function deleteFilesBestEffort(
  keys: ReadonlyArray<string | null | undefined>,
  stage: string,
): Promise<void | undefined> {
  const targets = keys.filter((key): key is string => !!key);
  if (targets.length === 0) return Promise.resolve();
  const work = Promise.allSettled(targets.map((key) => deleteFile(key))).then(
    (results) => {
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failed) throw failed.reason;
    },
  );
  return bestEffort(work, {
    what: stage,
    tags: { component: "storage", stage, storage_operation: "delete" },
  });
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!adapter.enabled) return null;
  try {
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the storage
    // key (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    return await adapter.getSignedUrl(
      key,
      expiresIn,
      responseContentDisposition,
      downloadFilename,
    );
  } catch (error) {
    throw new AppError(
      "storage.signed_url_failed",
      "Object storage signed URL failed",
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

/**
 * Cache slot for a document version's extracted plain text (see the
 * document.precompute_text job). Keyed by version id alone: versions are
 * immutable apart from two in-place rewrite sites, both of which invalidate
 * this key, so the version id fully identifies the bytes the text came from.
 */
export function extractedTextKey(versionId: string): string {
  return `extracted-text/${versionId}.txt`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}

// ---------------------------------------------------------------------------
// Streamed signed uploads (filesystem driver)
// ---------------------------------------------------------------------------

/**
 * Redeem a backend-minted upload capability by streaming the request body
 * into storage. Only the filesystem driver mints those capabilities (an S3
 * store takes the browser's presigned PUT directly), so a transport without
 * writeBlobFromStream rejects the call rather than silently dropping bytes.
 */
export async function writeBlobFromStream(
  key: string,
  body: Readable,
  maxBytes: number,
): Promise<number> {
  if (!adapter.writeBlobFromStream) {
    throw new Error("writeBlobFromStream is only available on the fs driver");
  }
  requireStorageConfig();
  return adapter.writeBlobFromStream(key, body, maxBytes);
}

/** Remove a partially written blob after a failed or oversized upload. */
export async function discardBlob(key: string): Promise<void> {
  await adapter.discardBlob?.(key);
}
