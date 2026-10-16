/**
 * Filesystem storage adapter — STORAGE_DRIVER=fs. Built for the
 * self-contained desktop app (no storage daemon to supervise), but works for
 * any single-node deploy. Objects live under STORAGE_FS_ROOT, one file per
 * storage key.
 *
 * The filesystem has no presigned URLs, so signed downloads and direct
 * uploads are backend-served instead: an expiring HMAC "blob token" (see
 * ../downloadTokens.ts) on the unauthenticated /download/signed/:token route
 * carries the same capability semantics a presigned URL has. BACKEND_PUBLIC_URL
 * must be the browser-reachable base URL of this backend (the desktop
 * supervisor sets it; it defaults to localhost:PORT, which is correct for
 * local single-machine use).
 */

import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs, { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { signBlobToken, signBlobUploadToken } from "../downloadTokens";
import type { StorageAdapter } from "./adapter";
import { normalizeDownloadFilename } from "./filenames";

export class BlobUploadSizeError extends Error {
  constructor() {
    super("Upload size does not match the link");
    this.name = "BlobUploadSizeError";
  }
}

function backendPublicUrl(): string {
  return (
    process.env.BACKEND_PUBLIC_URL ??
    `http://localhost:${process.env.PORT ?? 3001}`
  ).replace(/\/+$/, "");
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

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function createFilesystemStorageAdapter(): StorageAdapter {
  const fsRoot = process.env.STORAGE_FS_ROOT;

  // The one place a storage key becomes a filesystem path. Every fs call in this
  // adapter goes through here, so containment is proven once rather than trusted
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
    const root = path.resolve(fsRoot!);
    const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
    const resolved = path.resolve(root, key);
    if (!resolved.startsWith(rootPrefix)) {
      throw new Error(`storage key escapes STORAGE_FS_ROOT: ${key}`);
    }
    return resolved;
  }

  /**
   * Stream a request body straight onto disk for the signed PUT route.
   * Streaming (rather than an express body parser) is what keeps a
   * multi-hundred-megabyte upload from being buffered in the process.
   * Rejects before any byte beyond the capability's signed limit reaches
   * disk. The request remains readable after rejection so the route can
   * return its validation response instead of resetting the connection.
   */
  async function writeBlobFromStream(
    key: string,
    body: Readable,
    maxBytes: number,
  ): Promise<number> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new BlobUploadSizeError();
    }
    const target = fsPathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Stream into a sibling temp file and rename on success, so an aborted or
    // oversized upload never truncates a blob already stored at this key and
    // never leaves a partial file behind for any caller.
    const temp = `${target}.${randomUUID()}.part`;
    const handle = await fs.open(temp, "wx");
    let committed = false;
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
      if (written !== maxBytes) throw new BlobUploadSizeError();
      await fs.rename(temp, target);
      committed = true;
    } finally {
      body.unpipe(bounded);
      body.off("error", abort);
      body.off("aborted", aborted);
      body.off("close", closed);
      // Drain a rejected request without writing it. Keeping the incoming HTTP
      // stream out of pipeline lets Express send the expected 400 response.
      if (!body.readableEnded && !body.destroyed) body.resume();
      await handle.close().catch(() => {});
      if (!committed) await fs.rm(temp, { force: true }).catch(() => {});
    }
    return written;
  }

  return {
    enabled: Boolean(fsRoot),
    configurationHint: "STORAGE_FS_ROOT must be set when STORAGE_DRIVER=fs",

    async uploadFile(key, content) {
      const target = fsPathFor(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, Buffer.from(content));
    },

    async uploadFileFromPath(key, filePath) {
      const target = fsPathFor(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // copyFile streams internally, so a large generated PDF never has to be
      // buffered whole the way the ArrayBuffer overload above would.
      await fs.copyFile(filePath, target);
    },

    async getSignedUploadUrl(key, contentType, expectedSizeBytes, expiresIn) {
      // The write-side twin of the blob token: an expiring HMAC capability
      // naming exactly one key, content type and byte count, redeemed by PUT
      // on the same /download/signed/:token route the read tokens use. The
      // declared type and size are inside the signature, so — as with an S3
      // presigned PUT — the capability cannot be replayed with another body.
      const token = signBlobUploadToken(
        key,
        contentType,
        expectedSizeBytes,
        expiresIn,
      );
      return `${backendPublicUrl()}/download/signed/${token}`;
    },

    async downloadFile(key) {
      try {
        const bytes = await fs.readFile(fsPathFor(key));
        return bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer;
      } catch (error) {
        // A missing file is an answer (null), not a failure worth logging.
        if (isMissingFile(error)) return null;
        throw error;
      }
    },

    async openReadStream(key) {
      // createReadStream opens lazily, so the facade's contract holds:
      // nothing is read until a consumer pulls.
      return createReadStream(fsPathFor(key));
    },

    async headFile(key) {
      try {
        const info = await stat(fsPathFor(key));
        // No etag: the filesystem has no equivalent, and every caller treats
        // a null etag as "not available" rather than "mismatch".
        return { size: info.size, etag: null, contentType: null };
      } catch (error) {
        if (isMissingFile(error)) return null;
        throw error;
      }
    },

    async listFiles(prefix) {
      // S3 prefixes are plain string prefixes, not directories
      // ("documents/u1/d" matches "documents/u1/d2/…"). Walk the deepest
      // whole directory in the prefix, then string-filter, so the two
      // drivers agree exactly.
      const root = path.resolve(fsRoot!);
      const lastSlash = prefix.lastIndexOf("/");
      const dirPart = lastSlash >= 0 ? prefix.slice(0, lastSlash) : "";
      const all: string[] = [];
      await fsWalk(dirPart ? fsPathFor(dirPart) : root, all, root);
      return all.filter((key) => key.startsWith(prefix)).sort();
    },

    async copyFile(sourceKey, targetKey) {
      const target = fsPathFor(targetKey);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(fsPathFor(sourceKey), target);
    },

    async deleteFile(key) {
      try {
        await fs.unlink(fsPathFor(key));
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    },

    async getSignedUrl(key, expiresIn, _responseContentDisposition, downloadFilename) {
      // The /download/signed route sets Content-Disposition itself from the
      // filename inside the token, so the prebuilt header is not needed here.
      const filename =
        downloadFilename ?? normalizeDownloadFilename(path.posix.basename(key));
      return `${backendPublicUrl()}/download/signed/${signBlobToken(key, filename, expiresIn)}`;
    },

    writeBlobFromStream,

    async discardBlob(key) {
      await fs.rm(fsPathFor(key), { force: true }).catch(() => {});
    },
  };
}
