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
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const GetObjectCommand = (S3Commands as any).GetObjectCommand;

let cachedClient: S3Client | undefined;
let cachedUploadSigningClient:
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

function getUploadSigningClient(): S3Client {
  const endpoint =
    process.env.R2_PUBLIC_ENDPOINT_URL || process.env.R2_ENDPOINT_URL!;
  if (cachedUploadSigningClient?.endpoint === endpoint) {
    return cachedUploadSigningClient.client;
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
  cachedUploadSigningClient = { endpoint, client };
  return client;
}

const BUCKET = process.env.R2_BUCKET_NAME ?? "mike";

export const storageEnabled = Boolean(
  process.env.R2_ENDPOINT_URL &&
  process.env.R2_ACCESS_KEY_ID &&
  process.env.R2_SECRET_ACCESS_KEY,
);

function requireStorageConfig(): void {
  if (!storageEnabled) {
    throw new Error(
      "R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set",
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
  try {
    const client = getUploadSigningClient();
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
  constructor(operation: string, options?: { cause?: unknown }) {
    super(`Object storage ${operation} failed`, options);
    this.name = "StorageOperationError";
  }
}

export async function headFile(
  key: string,
): Promise<StoredObjectMetadata | null> {
  if (!storageEnabled) return null;
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
 * Read an object without collapsing an operational storage failure into a
 * missing file. Memory uses this stricter contract because treating a timeout
 * as an empty memory.md could make a curator overwrite durable context.
 */
export async function downloadFileStrict(
  key: string,
): Promise<ArrayBuffer | null> {
  requireStorageConfig();
  try {
    const response = (await getClient().send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    )) as any;
    if (!response.Body) {
      throw new StorageOperationError("download");
    }
    const bytes = await response.Body.transformToByteArray();
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } })
      .$metadata?.httpStatusCode;
    if (status === 404) return null;
    if (error instanceof StorageOperationError) throw error;
    throw new StorageOperationError("download", { cause: error });
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

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
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
  try {
    const client = getClient();
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
