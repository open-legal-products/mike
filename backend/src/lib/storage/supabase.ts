/**
 * Supabase Storage adapter (`STORAGE_DRIVER=supabase`).
 *
 * Stores objects in a private bucket of the same Supabase project the
 * database and Auth already use, so a deployment needs no separate
 * S3-compatible service or access keys. The Vercel deployment uses it
 * (docs/vercel.md); any install may.
 *
 * Required env vars (already set for the backend):
 *   SUPABASE_URL        — https://<project-ref>.supabase.co
 *   SUPABASE_SECRET_KEY — service-role / secret key (server-side only)
 * Optional:
 *   SUPABASE_STORAGE_BUCKET — bucket name (default: "mike"). The bucket must
 *                             exist and be private; the Vercel bootstrap
 *                             (backend/scripts/vercel-start.sh) creates it.
 *
 * Browser uploads use Supabase signed upload URLs: a single-use token for one
 * object path. Unlike an S3 presign, the token does not bind the body's size
 * or type, so the upload-session seal step (modules/uploads) is what enforces
 * them: it compares the staged object's size and type with the declared ones
 * and deletes a mismatch before anything reads it.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { createClient } from "@supabase/supabase-js";
import type { StorageAdapter } from "./adapter";
import { storageReadTimeoutMs } from "./timeouts";

type StorageErrorShape = {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  message?: unknown;
};

/**
 * Supabase Storage answers a missing object with HTTP 400 or 404 and a body
 * whose statusCode is "404" ("Object not found", code NoSuchKey on newer
 * servers). A missing *bucket* uses the same statusCode, so it is told apart
 * by its own code/message: a wrong bucket name must stay a failure, or the
 * durable cleanup jobs would record never-deleted bytes as gone (see the
 * matching note in ./s3.ts deleteFile).
 */
export function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, statusCode, code, message } = error as StorageErrorShape;
  const text = typeof message === "string" ? message.toLowerCase() : "";
  if (code === "NoSuchBucket" || text.includes("bucket not found")) return false;
  if (code === "NoSuchKey") return true;
  return statusCode === "404" || status === 404 || text === "object not found";
}

/** Supabase Storage's answer when the destination of a write already exists. */
function isExistingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, statusCode, message } = error as StorageErrorShape;
  return (
    status === 409 ||
    statusCode === "409" ||
    (typeof message === "string" && /already exists/i.test(message))
  );
}

/** A fetch Response that is not 2xx, as a StorageApiError-shaped error. */
async function responseError(response: Response): Promise<Error> {
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Not JSON (HEAD, proxy error page); the status is all there is.
  }
  const error = new Error(
    typeof body.message === "string" ? body.message : `Storage HTTP ${response.status}`,
  ) as Error & StorageErrorShape;
  error.name = "SupabaseStorageError";
  error.status = response.status;
  error.statusCode = body.statusCode ?? String(response.status);
  error.code = body.code ?? body.error;
  return error;
}

function encodeKey(key: string): string {
  return key.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

export function createSupabaseStorageAdapter(): StorageAdapter {
  const baseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "mike";
  const enabled = Boolean(baseUrl && secretKey);

  let cachedClient: ReturnType<typeof createClient> | undefined;
  function files() {
    cachedClient ??= createClient(baseUrl!, secretKey!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return cachedClient.storage.from(bucket);
  }

  function storageUrl(path: string): string {
    return `${baseUrl}/storage/v1${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { apikey: secretKey!, authorization: `Bearer ${secretKey}` };
  }

  /** Raw authenticated GET, for streaming reads storage-js would buffer. */
  async function getObject(key: string, signal?: AbortSignal): Promise<Response | null> {
    const response = await fetch(
      storageUrl(`/object/authenticated/${bucket}/${encodeKey(key)}`),
      { headers: authHeaders(), signal },
    );
    if (response.ok) return response;
    const error = await responseError(response);
    if (isMissingObject(error)) return null;
    throw error;
  }

  async function putObject(
    key: string,
    body: BodyInit,
    contentType: string,
    contentLength?: number,
  ): Promise<void> {
    const init: RequestInit & { duplex?: "half" } = {
      method: "POST",
      headers: {
        ...authHeaders(),
        "content-type": contentType,
        "x-upsert": "true",
        ...(contentLength !== undefined ? { "content-length": String(contentLength) } : {}),
      },
      body,
    };
    if (body instanceof ReadableStream) init.duplex = "half";
    const response = await fetch(storageUrl(`/object/${bucket}/${encodeKey(key)}`), init);
    if (!response.ok) throw await responseError(response);
    await response.body?.cancel();
  }

  return {
    enabled,
    configurationHint:
      "SUPABASE_URL and SUPABASE_SECRET_KEY must be set for STORAGE_DRIVER=supabase",

    async uploadFile(key, content, contentType) {
      await putObject(key, Buffer.from(content), contentType, content.byteLength);
    },

    async uploadFileFromPath(key, filePath, contentType) {
      const { size } = await stat(filePath);
      const stream = createReadStream(filePath);
      try {
        await putObject(
          key,
          Readable.toWeb(stream) as ReadableStream<Uint8Array>,
          contentType,
          size,
        );
      } finally {
        if (!stream.destroyed) stream.destroy();
      }
    },

    async getSignedUploadUrl(key) {
      // Expiry is fixed by Supabase (two hours) and size/type are checked at
      // seal time; see the module comment.
      const { data, error } = await files().createSignedUploadUrl(key, { upsert: true });
      if (error) throw error;
      return data.signedUrl;
    },

    async downloadFile(key) {
      const signal = AbortSignal.timeout(storageReadTimeoutMs());
      const response = await getObject(key, signal);
      if (!response) return null;
      return await response.arrayBuffer();
    },

    async openReadStream(key, options) {
      const response = await getObject(key, options?.signal);
      if (!response?.body) return null;
      return response.body as unknown as AsyncIterable<Uint8Array>;
    },

    async headFile(key) {
      const { data, error } = await files().info(key);
      if (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
      const info = data as {
        size?: number | null;
        contentType?: string | null;
        etag?: string | null;
        metadata?: { size?: number; mimetype?: string; eTag?: string } | null;
      };
      return {
        size: info.size ?? info.metadata?.size ?? 0,
        etag: info.etag ?? info.metadata?.eTag ?? null,
        contentType: info.contentType ?? info.metadata?.mimetype ?? null,
      };
    },

    async listFiles(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const { data, error } = await files().listV2({
          prefix,
          limit: 1000,
          with_delimiter: false,
          ...(cursor ? { cursor } : {}),
        });
        if (error) throw error;
        for (const object of data.objects ?? []) {
          const key = (object as { key?: string }).key ?? object.name;
          if (key) keys.push(key);
        }
        cursor = data.hasNext ? data.nextCursor : undefined;
      } while (cursor);
      return keys;
    },

    async copyFile(sourceKey, targetKey) {
      if (sourceKey === targetKey) return;
      const { error } = await files().copy(sourceKey, targetKey);
      if (!error) return;
      // Copy refuses an existing destination. Callers copy to a fresh key or
      // retry after a crash left the target behind, so replace it then; any
      // other failure leaves the target untouched.
      if (!isExistingObject(error)) throw error;
      const { error: removeError } = await files().remove([targetKey]);
      if (removeError) throw removeError;
      const { error: retryError } = await files().copy(sourceKey, targetKey);
      if (retryError) throw retryError;
    },

    async deleteFile(key) {
      // remove() answers a missing key with an empty list, not an error; a
      // missing bucket or bad credentials still come back as errors.
      const { error } = await files().remove([key]);
      if (error) throw error;
    },

    async getSignedUrl(key, expiresIn, responseContentDisposition, downloadFilename) {
      // Supabase sets Content-Disposition itself: `download` makes it an
      // attachment with that filename; without it the object is served
      // inline, which is what an inline disposition asks for.
      const attachment = /^\s*attachment/i.test(responseContentDisposition ?? "");
      const { data, error } = await files().createSignedUrl(
        key,
        expiresIn,
        attachment ? { download: downloadFilename || true } : undefined,
      );
      if (error) throw error;
      return data.signedUrl;
    },
  };
}
