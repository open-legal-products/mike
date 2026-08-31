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
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import * as S3Commands from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs/promises";
import path from "path";
import { signBlobToken } from "./downloadTokens";

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

function getClient(): S3Client {
  if (!cachedClient) {
    cachedClient = new S3Client({
      region: "auto",
      endpoint: process.env.R2_ENDPOINT_URL!,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return cachedClient;
}

// Presigned URLs are handed to the user's browser, so their signature must be
// computed against an endpoint the browser can actually reach. Self-hosted
// deploys talk to storage over the compose network (http://storage:9000) — a
// hostname that only resolves inside Docker, and an S3 signature is bound to
// the host it was signed for, so the URL can't simply be rewritten afterwards.
// R2_PUBLIC_ENDPOINT_URL lets those deploys sign against the host-published
// endpoint instead; cloud R2/S3 endpoints are already public, so it defaults
// to R2_ENDPOINT_URL and nothing changes there.
// Read once at module load, like the internal client's config: the endpoint is
// static per process, and reading it here (rather than per call) keeps the
// cache honest — a frozen client can't disagree with a re-read env var.
const PRESIGN_ENDPOINT = process.env.R2_PUBLIC_ENDPOINT_URL;
let cachedPresignClient: S3Client | undefined;

function getPresignClient(): S3Client {
  if (!PRESIGN_ENDPOINT) return getClient();
  if (!cachedPresignClient) {
    cachedPresignClient = new S3Client({
      region: "auto",
      endpoint: PRESIGN_ENDPOINT,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
  }
  return cachedPresignClient;
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

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  if (FS_DRIVER) {
    try {
      await fs.unlink(fsPathFor(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }
    return;
  }
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
  if (FS_DRIVER) {
    const filename =
      downloadFilename ?? normalizeDownloadFilename(path.posix.basename(key));
    const token = signBlobToken(key, filename, expiresIn);
    return `${backendPublicUrl()}/download/signed/${token}`;
  }
  try {
    const client = getPresignClient();
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

export function workflowReferenceKey(
  userId: string,
  workflowId: string,
  referenceId: string,
  contentHash: string,
  filename: string,
): string {
  return `workflow-references/${userId}/${workflowId}/${referenceId}/${contentHash}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}
