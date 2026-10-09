/**
 * S3-protocol storage adapter — Cloudflare R2 in production, RustFS in the
 * local compose stack, MinIO in CI. Any S3-compatible service works.
 *
 * Required env vars:
 *   R2_ENDPOINT_URL      — https://<account-id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID     — API token (Access Key ID)
 *   R2_SECRET_ACCESS_KEY — API token (Secret Access Key)
 *   R2_BUCKET_NAME       — bucket name (default: "mike")
 *   R2_PUBLIC_ENDPOINT_URL — origin browsers reach, when it differs from the
 *                            server-side endpoint (presigned uploads and downloads)
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
import type { StorageAdapter } from "./adapter";

const GetObjectCommand = (S3Commands as any).GetObjectCommand;

// The SDK defaults to computing a CRC32 checksum for every PutObject. When a
// request is only presigned, that checksum is computed over the *empty*
// signable body and hoisted into the query string, so a checksum-validating
// store rejects the browser's real body. Only send a checksum where the S3
// operation actually requires one.
const CHECKSUM_DEFAULTS = {
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
} as const;

export function createS3StorageAdapter(): StorageAdapter {
  const bucket = process.env.R2_BUCKET_NAME ?? "mike";
  const enabled = Boolean(
    process.env.R2_ENDPOINT_URL &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY,
  );

  let cachedClient: S3Client | undefined;
  function client(): S3Client {
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

  let cachedBrowserSigningClient:
    | { endpoint: string; client: S3Client }
    | undefined;
  function browserSigningClient(): S3Client {
    const endpoint =
      process.env.R2_PUBLIC_ENDPOINT_URL || process.env.R2_ENDPOINT_URL!;
    if (cachedBrowserSigningClient?.endpoint === endpoint) {
      return cachedBrowserSigningClient.client;
    }
    const signingClient = new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: true,
      ...CHECKSUM_DEFAULTS,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    });
    cachedBrowserSigningClient = { endpoint, client: signingClient };
    return signingClient;
  }

  return {
    enabled,
    configurationHint:
      "R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set",

    async uploadFile(key, content, contentType) {
      await client().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: Buffer.from(content),
          ContentType: contentType,
        }),
      );
    },

    async uploadFileFromPath(key, filePath, contentType) {
      const metadata = await stat(filePath);
      const body = createReadStream(filePath);
      try {
        await client().send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentLength: metadata.size,
            ContentType: contentType,
          }),
        );
      } finally {
        if (!body.destroyed) body.destroy();
      }
    },

    async getSignedUploadUrl(key, contentType, expectedSizeBytes, expiresIn) {
      return await awsGetSignedUrl(
        browserSigningClient(),
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          ContentType: contentType,
          ContentLength: expectedSizeBytes,
        }),
        {
          expiresIn,
          signableHeaders: new Set(["content-type", "content-length"]),
        },
      );
    },

    async downloadFile(key) {
      const response = (await client().send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )) as any;
      if (!response.Body) return null;
      const bytes = await response.Body.transformToByteArray();
      return bytes.buffer as ArrayBuffer;
    },

    async openReadStream(key) {
      const response = (await client().send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      )) as any;
      return (response.Body as AsyncIterable<Uint8Array> | undefined) ?? null;
    },

    async headFile(key) {
      try {
        const response = await client().send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return {
          size: response.ContentLength ?? 0,
          etag: response.ETag ?? null,
          contentType: response.ContentType ?? null,
        };
      } catch (error) {
        // A missing object is an expected answer, not a transport failure —
        // translate it here, where the protocol's 404 shape is known.
        const status = (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw error;
      }
    },

    async listFiles(prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const response = await client().send(
          new ListObjectsV2Command({
            Bucket: bucket,
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
    },

    async copyFile(sourceKey, targetKey) {
      const copySource = encodeURIComponent(`${bucket}/${sourceKey}`).replace(
        /%2F/g,
        "/",
      );
      await client().send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: targetKey,
          CopySource: copySource,
        }),
      );
    },

    async deleteFile(key) {
      try {
        await client().send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch (error) {
        // "The object is not there" is the outcome a delete asks for, but
        // only the store's own answer to that effect may count. S3, R2 and
        // MinIO answer a DeleteObject on a missing key with 204; an
        // S3-compatible store that answers 404 instead names the reason in
        // the body, and the SDK surfaces that as `NoSuchKey`. A 404 WITHOUT
        // that code (the SDK calls it "NotFound") is what a wrong endpoint, a
        // proxy path or a bucket-level 404 produce while the object may well
        // still exist. Treating it as success would let the durable cleanup
        // jobs (dbq/storageCleanup, documents.cleanupJobs, user.dataCleanup)
        // record the key as deleted, stop retrying, and leave the bytes
        // behind for good, so anything other than NoSuchKey stays a failure.
        if ((error as { name?: unknown } | null)?.name === "NoSuchKey") return;
        throw error;
      }
    },

    async getSignedUrl(key, expiresIn, responseContentDisposition) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: responseContentDisposition,
      }) as any;
      return awsGetSignedUrl(browserSigningClient(), command, { expiresIn });
    },
  };
}
