/**
 * Transport interface for object-storage backends.
 *
 * The facade in ../storage.ts owns policy — the not-configured degradation
 * (reads return null/empty, writes throw), error logging, and the
 * StorageOperationError wrapping callers catch — so adapters only move bytes.
 * Implementations may assume their methods are called only while `enabled` is
 * true, and should let errors propagate to the facade.
 *
 * To ship Mike on a different object store (Azure Blob, GCS, local disk),
 * implement this type in one file and pass it to setStorageAdapter() from
 * ../storage.ts before the first request is served. No call site changes.
 */

import type { Readable } from "node:stream";

export type StoredObjectMetadata = {
  size: number;
  etag: string | null;
  contentType: string | null;
};

export type StorageAdapter = {
  /** True when the backing service has all the configuration it needs. */
  readonly enabled: boolean;
  /**
   * Shown in the error thrown when a write is attempted while disabled.
   * Name the exact configuration the operator must set.
   */
  readonly configurationHint: string;

  uploadFile(
    key: string,
    content: ArrayBuffer,
    contentType: string,
  ): Promise<void>;
  /**
   * Stream a file that is already on local disk. Path-based rather than
   * stream-based because every SDK worth adapting has a "send this file"
   * entry point that handles content length and retries better than a
   * hand-rolled stream would (S3 PutObject with ContentLength, Azure
   * BlockBlobClient.uploadFile). The adapter owns the read handle's lifecycle.
   */
  uploadFileFromPath(
    key: string,
    filePath: string,
    contentType: string,
  ): Promise<void>;
  /**
   * Presign a single direct browser `PUT`. The declared content type and byte
   * count must be bound into the signature so the URL cannot be replayed with
   * a different body.
   */
  getSignedUploadUrl(
    key: string,
    contentType: string,
    expectedSizeBytes: number,
    expiresIn: number,
  ): Promise<string | null>;

  downloadFile(key: string): Promise<ArrayBuffer | null>;
  /**
   * Open an object for streaming reads, or resolve null when it has no body.
   * Returns the raw byte iterable; the facade wraps it in a Node stream and
   * owns the lazy-start and error-translation behavior around it.
   */
  openReadStream(key: string): Promise<AsyncIterable<Uint8Array> | null>;
  /** Object metadata, or null when the object does not exist. */
  headFile(key: string): Promise<StoredObjectMetadata | null>;
  /** Every key under the prefix, following pagination to the end. */
  listFiles(prefix: string): Promise<string[]>;

  copyFile(sourceKey: string, targetKey: string): Promise<void>;
  /**
   * Resolve when the object is gone, including when the store itself answers
   * that it never existed. Throw for anything else (auth, network, a 404
   * that does not name the object): durable cleanup jobs treat a resolved
   * delete as final and stop retrying.
   */
  deleteFile(key: string): Promise<void>;

  /**
   * A URL a browser can fetch directly for `expiresIn` seconds.
   * `responseContentDisposition` is a complete Content-Disposition header
   * value the storage service must echo on its response (S3
   * response-content-disposition, Azure SAS rscd). `downloadFilename` is the
   * raw name it was built from, for transports that serve the download
   * themselves and set the header on their own response (the filesystem
   * driver's backend-served URL).
   */
  getSignedUrl(
    key: string,
    expiresIn: number,
    responseContentDisposition?: string,
    downloadFilename?: string,
  ): Promise<string | null>;

  /**
   * Optional: redeem a backend-minted upload capability by streaming a
   * request body to `key`, rejecting any body that is not exactly `maxBytes`
   * long, and resolve with the byte count written. Needed only by transports
   * whose getSignedUploadUrl points the browser back at this backend (the
   * filesystem driver); stores that accept presigned PUTs leave it out.
   * Must commit atomically: a rejected body leaves any existing object intact.
   */
  writeBlobFromStream?(
    key: string,
    body: Readable,
    maxBytes: number,
  ): Promise<number>;
  /** Optional companion to writeBlobFromStream: best-effort removal. */
  discardBlob?(key: string): Promise<void>;
};
