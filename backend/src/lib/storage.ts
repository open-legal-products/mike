/**
 * Cloudflare R2 storage utilities for Mike document management.
 * R2 is S3-compatible — uses @aws-sdk/client-s3.
 *
 * Required env vars:
 *   R2_ENDPOINT_URL     — https://<account-id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID    — R2 API token (Access Key ID)
 *   R2_SECRET_ACCESS_KEY — R2 API token (Secret Access Key)
 *   R2_BUCKET_NAME      — bucket name (default: "mike")
 */

import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as S3Commands from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import { bestEffort } from "./observability/sentry";
import { createReadStream } from "node:fs";
import fs, { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { signBlobToken, signBlobUploadToken } from "./downloadTokens";

// ---------------------------------------------------------------------------
// Driver selection — STORAGE_DRIVER=fs swaps the S3 client for the local
// filesystem, keeping this module's public API identical. Built for the
// self-contained desktop app (no storage daemon to supervise), but works for
// any single-node deploy. Everything below the dispatch points is unchanged
// S3 code.
//
// fs mode has no presigned URLs, so getSignedUrl returns a backend-served
// URL instead: an expiring HMAC "blob token" (see downloadTokens.ts) on the
// unauthenticated /download/signed/:token route — the same capability
// semantics a presigned URL has. BACKEND_PUBLIC_URL must be the
// browser-reachable base URL of this backend (the desktop supervisor sets
// it; defaults to localhost:PORT which is correct for local single-machine
// use).
// ---------------------------------------------------------------------------

const FS_DRIVER = process.env.STORAGE_DRIVER === "fs";
const FS_ROOT = process.env.STORAGE_FS_ROOT;

function backendPublicUrl(): string {
  return (
    process.env.BACKEND_PUBLIC_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`
  ).replace(/\/+$/, "");
}

// The one place a storage key becomes a filesystem path. Every fs call in this
// module goes through here, so containment is proven once rather than trusted
// three times.
//
// Keys are backend-constructed today, but they are built from user-supplied
// filenames, so resolve-and-check anyway: path.join alone is not a fence —
// it *canonicalizes* "../" rather than rejecting it, so join(root, "../x")
// happily lands outside root, and an absolute key ignores root entirely.
// path.resolve collapses both cases into one absolute path we can then test.
//
// The test is deliberately a SINGLE startsWith guard. An earlier shape —
//   if (resolved !== root && !resolved.startsWith(root + path.sep)) throw
// — is equally safe at runtime, but falling through it only proves a
// *disjunction* ("resolved is exactly root" OR "resolved is under root"),
// which neither a reader nor a static analyser can reduce to a containment
// fact; CodeQL reported the fs calls below as js/path-injection for precisely
// that reason. Falling through the form below proves one thing and nothing
// weaker: resolved is under rootPrefix.
//
// Comparing against root + path.sep, not bare root, is what closes the classic
// sibling escape — "/data/store-evil" startsWith "/data/store". The endsWith
// guard keeps that correct when root is itself a separator (e.g. "/").
function fsPathFor(key: string): string {
  const root = path.resolve(FS_ROOT!);
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  const resolved = path.resolve(root, key);
  if (!resolved.startsWith(rootPrefix)) {
    throw new Error(`storage key escapes STORAGE_FS_ROOT: ${key}`);
  }
  return resolved;
}

async function fsWalk(dir: string, out: string[], root: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await fsWalk(full, out, root);
    else if (entry.isFile())
      out.push(path.relative(root, full).split(path.sep).join("/"));
  }
}

const GetObjectCommand = (S3Commands as any).GetObjectCommand;

let cachedClient: S3Client | undefined;
let cachedBrowserSigningClient:
  | { endpoint: string; client: S3Client }
  | undefined;

// The SDK defaults to computing a CRC32 checksum for every PutObject. When a
// request is only presigned, that checksum is computed over the *empty*
// signable body and hoisted into the query string, so a checksum-validating
// store rejects the browser's real body. Only send a checksum where the S3
// operation actually requires one.
const CHECKSUM_DEFAULTS = {
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
} as const;

function getClient(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT_URL!,
      forcePathStyle: true,
      ...CHECKSUM_DEFAULTS,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return cachedClient;
}

// Every URL we presign and hand to the *browser* must be signed against an
// endpoint the browser can actually reach. Self-hosted deploys talk to storage
// over the compose network (http://storage:9000) — a hostname that only
// resolves inside Docker — and an S3 signature is bound to the host it was
// signed for, so the URL cannot be rewritten after the fact.
// R2_PUBLIC_ENDPOINT_URL lets those deploys sign against the host-published
// endpoint; cloud R2/S3 endpoints are already public, so it falls back to
// R2_ENDPOINT_URL and nothing changes there. Used for both direct-upload PUTs
// and presigned downloads.
function getBrowserSigningClient(): S3Client {
  const endpoint =
    process.env.R2_PUBLIC_ENDPOINT_URL || process.env.R2_ENDPOINT_URL!;
  if (cachedBrowserSigningClient?.endpoint === endpoint) {
    return cachedBrowserSigningClient.client;
  }
  const client = new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    ...CHECKSUM_DEFAULTS,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  cachedBrowserSigningClient = { endpoint, client };
  return client;
}

const BUCKET = process.env.R2_BUCKET_NAME ?? "mike";

export const storageEnabled = FS_DRIVER
  ? Boolean(FS_ROOT)
  : Boolean(
      process.env.R2_ENDPOINT_URL &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY,
    );

function requireStorageConfig(): void {
  if (!storageEnabled) {
    throw new Error(
      FS_DRIVER
        ? "STORAGE_FS_ROOT must be set when STORAGE_DRIVER=fs"
        : "R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set",
    );
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
  if (FS_DRIVER) {
    const target = fsPathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(content));
    return;
  }
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(content),
      ContentType: contentType,
    }),
  );
}

export async function uploadFileFromPath(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  requireStorageConfig();
  if (FS_DRIVER) {
    const target = fsPathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      // copyFile streams internally, so a large generated PDF never has to be
      // buffered whole the way the ArrayBuffer overload above would.
      await fs.copyFile(filePath, target);
    } catch (error) {
      throw new StorageOperationError("upload", { cause: error });
    }
    return;
  }
  const metadata = await stat(filePath);
  const body = createReadStream(filePath);
  try {
    await getClient().send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentLength: metadata.size,
        ContentType: contentType,
      }),
    );
  } catch (error) {
    throw new StorageOperationError("upload", { cause: error });
  } finally {
    if (!body.destroyed) body.destroy();
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
  if (!storageEnabled) return null;
  if (FS_DRIVER) {
    // There is no object store to presign against, so mint the write-side
    // twin of the blob token: an expiring HMAC capability naming exactly one
    // key, content type and byte count, redeemed by PUT on the same
    // /download/signed/:token route the read tokens use. The declared type and
    // size are inside the signature, so — as with the S3 URL this replaces —
    // the capability cannot be replayed with a different body.
    return `${backendPublicUrl()}/download/signed/${signBlobUploadToken(
      key,
      contentType,
      expectedSizeBytes,
      expiresIn,
    )}`;
  }
  try {
    const client = getBrowserSigningClient();
    return await awsGetSignedUrl(
      client,
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        ContentType: contentType,
        ContentLength: expectedSizeBytes,
      }),
      {
        expiresIn,
        signableHeaders: new Set(["content-type", "content-length"]),
      },
    );
  } catch (error) {
    console.error("[storage] getSignedUploadUrl failed", { key, error });
    return null;
  }
}

export type StoredObjectMetadata = {
  size: number;
  etag: string | null;
  contentType: string | null;
};

export class StorageOperationError extends Error {
  constructor(readonly operation: string, options?: { cause?: unknown }) {
    super(`Object storage ${operation} failed`, options);
    this.name = "StorageOperationError";
  }
}

export async function headFile(
  key: string,
): Promise<StoredObjectMetadata | null> {
  if (!storageEnabled) return null;
  if (FS_DRIVER) {
    try {
      const info = await stat(fsPathFor(key));
      // No etag: the filesystem has no equivalent, and every caller treats a
      // null etag as "not available" rather than "mismatch".
      return { size: info.size, etag: null, contentType: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      console.error("[storage] headFile failed", { key, error });
      throw new StorageOperationError("HEAD", { cause: error });
    }
  }
  try {
    const client = getClient();
    const response = await client.send(
      new HeadObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    return {
      size: response.ContentLength ?? 0,
      etag: response.ETag ?? null,
      contentType: response.ContentType ?? null,
    };
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status !== 404) {
      console.error("[storage] headFile failed", { key, error });
      throw new StorageOperationError("HEAD", { cause: error });
    }
    return null;
  }
}

export async function copyFile(
  sourceKey: string,
  targetKey: string,
): Promise<void> {
  requireStorageConfig();
  if (FS_DRIVER) {
    const target = fsPathFor(targetKey);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.copyFile(fsPathFor(sourceKey), target);
    } catch (error) {
      throw new StorageOperationError("copy", { cause: error });
    }
    return;
  }
  const client = getClient();
  const copySource = encodeURIComponent(`${BUCKET}/${sourceKey}`).replace(
    /%2F/g,
    "/",
  );
  try {
    await client.send(
      new CopyObjectCommand({
        Bucket: BUCKET,
        Key: targetKey,
        CopySource: copySource,
      }),
    );
  } catch (error) {
    throw new StorageOperationError("copy", { cause: error });
  }
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  if (FS_DRIVER) {
    try {
      const bytes = await fs.readFile(fsPathFor(key));
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("[storage] downloadFile failed", {
          key,
          error: error,
        });
      }
      return null;
    }
  }
  try {
    const client = getClient();
    const response = (await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    )) as any;
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return bytes.buffer as ArrayBuffer;
  } catch (error) {
    console.error("[storage] downloadFile failed", {
      key,
      error: error,
    });
    return null;
  }
}

/**
 * Lazily stream an object from R2. The GET starts only when a consumer reads
 * from the returned stream, allowing archive writers to apply backpressure
 * without buffering whole files or opening every object concurrently.
 */
export function createFileReadStream(key: string): Readable {
  return Readable.from(
    (async function* () {
      requireStorageConfig();
      if (FS_DRIVER) {
        try {
          // createReadStream keeps the same lazy, backpressure-respecting
          // contract the S3 branch has: nothing is read until a consumer pulls.
          yield* createReadStream(fsPathFor(key));
        } catch (error) {
          console.error("[storage] createFileReadStream failed", {
            key,
            error,
          });
          throw new StorageOperationError("download", { cause: error });
        }
        return;
      }
      try {
        const response = (await getClient().send(
          new GetObjectCommand({ Bucket: BUCKET, Key: key }),
        )) as any;
        if (!response.Body) {
          throw new StorageOperationError("download");
        }
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          yield chunk;
        }
      } catch (error) {
        console.error("[storage] createFileReadStream failed", { key, error });
        if (error instanceof StorageOperationError) throw error;
        throw new StorageOperationError("download", { cause: error });
      }
    })(),
  );
}

export async function listFiles(prefix: string): Promise<string[]> {
  if (!storageEnabled) return [];
  if (FS_DRIVER) {
    // S3 prefixes are plain string prefixes, not directories ("documents/u1/d"
    // matches "documents/u1/d2/…"). Walk the deepest whole directory in the
    // prefix, then string-filter, so the two drivers agree exactly.
    const root = path.resolve(FS_ROOT!);
    const lastSlash = prefix.lastIndexOf("/");
    const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash) : "";
    const all: string[] = [];
    await fsWalk(dirPart ? fsPathFor(dirPart) : root, all, root);
    return all.filter((k) => k.startsWith(prefix)).sort();
  }
  const client = getClient();
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
    }
    ContinuationToken = response.NextContinuationToken;
  } while (ContinuationToken);
  return keys;
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

// "The object is not there" is the outcome a delete asks for, but only the
// store's own answer to that effect may count. S3, R2 and MinIO answer a
// DeleteObject on a missing key with 204; an S3-compatible store that answers
// 404 instead names the reason in the body, and the SDK surfaces that as
// `NoSuchKey`. A 404 WITHOUT that code (the SDK calls it "NotFound") is what
// a wrong endpoint, a proxy path or a bucket-level 404 produce while the
// object may well still exist. Treating it as success would let the durable
// cleanup jobs (dbq/storageCleanup, documents.cleanupJobs, user.dataCleanup)
// record the key as deleted, stop retrying, and leave the bytes behind for
// good, so anything other than NoSuchKey stays a failure.
function isMissingObject(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NoSuchKey";
}

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  // An empty key names no object. Sent anyway, the SDK either rejects it
  // (a missing URI label) or, on some stores, addresses the bucket itself.
  if (!key) return;
  if (FS_DRIVER) {
    try {
      await fs.unlink(fsPathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return;
  }
  const client = getClient();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  } catch (error) {
    if (isMissingObject(error)) return;
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
    what: `storage-delete:${stage}`,
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
  if (!storageEnabled) return null;
  if (FS_DRIVER) {
    const filename =
      downloadFilename ?? normalizeDownloadFilename(path.posix.basename(key));
    const token = signBlobToken(key, filename, expiresIn);
    return `${backendPublicUrl()}/download/signed/${token}`;
  }
  try {
    // Signed download URLs are followed by the browser too, so they need the
    // same browser-reachable signing endpoint the direct-upload URLs use.
    const client = getBrowserSigningClient();
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the R2 key
    // (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    }) as any;
    return await awsGetSignedUrl(client, command, { expiresIn });
  } catch (error) {
    console.error("[storage] getSignedUrl failed", {
      key,
      error: error,
    });
    return null;
  }
}

/**
 * Stream a request body straight onto disk for the filesystem driver's signed
 * PUT route. Streaming (rather than an express body parser) is what keeps a
 * multi-hundred-megabyte upload from being buffered in the process.
 * Rejects before any byte beyond the capability's signed limit reaches disk.
 * The request remains readable after rejection so the route can return its
 * validation response instead of resetting the HTTP connection.
 */
export class BlobUploadSizeError extends Error {
  constructor() {
    super("Upload size does not match the link");
    this.name = "BlobUploadSizeError";
  }
}

export async function writeBlobFromStream(
  key: string,
  body: Readable,
  maxBytes: number,
): Promise<number> {
  if (!FS_DRIVER) {
    throw new Error("writeBlobFromStream is only available on the fs driver");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new BlobUploadSizeError();
  }
  const target = fsPathFor(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const handle = await fs.open(target, "w");
  let written = 0;
  const bounded = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > maxBytes - written) {
        callback(new BlobUploadSizeError());
        return;
      }
      written += chunk.length;
      callback(null, chunk);
    },
  });
  const abort = (error: Error) => bounded.destroy(error);
  const aborted = () => bounded.destroy(new Error("Upload aborted"));
  const closed = () => {
    if (!body.readableEnded) aborted();
  };
  body.once("error", abort);
  body.once("aborted", aborted);
  body.once("close", closed);
  try {
    if (body.destroyed) throw new Error("Upload aborted");
    const sink = handle.createWriteStream();
    const completed = pipeline(bounded, sink);
    body.pipe(bounded);
    await completed;
  } finally {
    body.unpipe(bounded);
    body.off("error", abort);
    body.off("aborted", aborted);
    body.off("close", closed);
    // Drain a rejected request without writing it. Keeping the incoming HTTP
    // stream out of pipeline lets Express send the expected 400 response.
    if (!body.readableEnded && !body.destroyed) body.resume();
    await handle.close().catch(() => {});
  }
  return written;
}

/** Remove a partially written blob after a failed or oversized upload. */
export async function discardBlob(key: string): Promise<void> {
  if (!FS_DRIVER) return;
  await fs.rm(fsPathFor(key), { force: true }).catch(() => {});
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name)
    .replace(/["\\]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
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

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
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
