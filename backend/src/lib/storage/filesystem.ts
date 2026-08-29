import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs, { stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { signBlobToken, signBlobUploadToken } from "../downloadTokens";
import type { StorageAdapter } from "./adapter";

export class BlobUploadSizeError extends Error {
  constructor() {
    super("Upload size does not match the link");
    this.name = "BlobUploadSizeError";
  }
}


/** Filesystem transport used by the self-contained Mac app and single-node installs. */
export function createFilesystemStorageAdapter(): StorageAdapter {
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

/** Remove a partially written blob after a failed or oversized upload. */
async function discardBlob(key: string): Promise<void> {
  await fs.rm(fsPathFor(key), { force: true }).catch(() => {});
}


return {
  enabled: Boolean(FS_ROOT),
  configurationHint: "STORAGE_FS_ROOT must be set when STORAGE_DRIVER=fs",
  writeBlobFromStream,
  discardBlob,
  async uploadFile(key, content) {
    const target = fsPathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(content));
  },
  async uploadFileFromPath(key, filePath) {
    const target = fsPathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(filePath, target);
  },
  async getSignedUploadUrl(key, contentType, expectedSizeBytes, expiresIn) {
    return `${backendPublicUrl()}/download/signed/${signBlobUploadToken(key, contentType, expectedSizeBytes, expiresIn)}`;
  },
  async downloadFile(key) {
    try {
      const bytes = await fs.readFile(fsPathFor(key));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  },
  async openReadStream(key) { return createReadStream(fsPathFor(key)); },
  async headFile(key) {
    try {
      const info = await stat(fsPathFor(key));
      return { size: info.size, etag: null, contentType: null };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  },
  async listFiles(prefix) {
    const root = path.resolve(FS_ROOT!);
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
    try { await fs.unlink(fsPathFor(key)); }
    catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
  },
  async getSignedUrl(key, expiresIn, _disposition, downloadFilename) {
    const filename = downloadFilename ?? (path.posix.basename(key).trim().replace(/[\x00-\x1F\x7F\\/]/g, "_") || "download");
    return `${backendPublicUrl()}/download/signed/${signBlobToken(key, filename, expiresIn)}`;
  },
};
}
