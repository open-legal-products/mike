// MIKE-BACKEND-5 (storage / seal-recover) and MIKE-BACKEND-6 (storage /
// session-expiry): best-effort deletes reported as warnings, two events per
// operation (staging + sealed key), with nothing on the event that said WHY.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  reports: [] as Array<{ error: unknown; what: string; tags: unknown }>,
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mocks.send;
  }
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client,
    PutObjectCommand: Command,
    CopyObjectCommand: Command,
    DeleteObjectCommand: Command,
    HeadObjectCommand: Command,
    ListObjectsV2Command: Command,
    GetObjectCommand: Command,
  };
});

// Stand-in for sentry.ts bestEffort with the same contract: swallow the
// rejection, report the ORIGINAL error once per call.
vi.mock("../observability/sentry", () => ({
  bestEffort: <T>(
    work: Promise<T>,
    context: { what: string; tags?: unknown },
  ) =>
    work.catch((error: unknown) => {
      mocks.reports.push({ error, what: context.what, tags: context.tags });
      return undefined;
    }),
}));

import { diagnosticErrorTags } from "../observability/sentryPrivacy";

let storage: typeof import("../storage");

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://r2.example.test";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  vi.resetModules();
  storage = await import("../storage.js");
});

beforeEach(() => {
  mocks.send.mockReset();
  mocks.reports.length = 0;
});

function s3Error(name: string, status: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status, requestId: "private" },
  });
}

// Node's net stack when nothing listens (a local MinIO that is not running).
function connectionRefused() {
  return Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
}

describe("deleteFile", () => {
  it("treats an object that is already gone as deleted", async () => {
    mocks.send.mockRejectedValue(s3Error("NoSuchKey", 404));
    await expect(storage.deleteFile("documents/u/d/a.pdf")).resolves.toBeUndefined();
  });

  it("never sends a delete for an empty key", async () => {
    await storage.deleteFile("");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  // A wrong endpoint or a proxy path answers 404 without NoSuchKey while the
  // object still exists. The durable cleanup jobs treat a resolved delete as
  // "gone" and stop retrying, so this must stay a failure they can see.
  it("does not treat a code-less 404 (NotFound) as deleted", async () => {
    mocks.send.mockRejectedValue(s3Error("NotFound", 404));
    await expect(storage.deleteFile("docs/a.pdf")).rejects.toMatchObject({
      name: "StorageOperationError",
      operation: "delete",
    });
  });

  it("does not treat any other 404 as deleted either", async () => {
    mocks.send.mockRejectedValue(s3Error("SomeProxyError", 404));
    await expect(storage.deleteFile("docs/a.pdf")).rejects.toMatchObject({
      name: "StorageOperationError",
    });
  });

  it("still fails on a missing BUCKET: that is misconfiguration, not success", async () => {
    mocks.send.mockRejectedValue(s3Error("NoSuchBucket", 404));
    await expect(storage.deleteFile("k")).rejects.toMatchObject({
      name: "StorageOperationError",
      operation: "delete",
    });
  });
});

describe("deleteFileBestEffort / deleteFilesBestEffort", () => {
  it("does not report a delete of an already-gone object", async () => {
    mocks.send.mockRejectedValue(s3Error("NoSuchKey", 404));
    await storage.deleteFileBestEffort("k", "seal-recover");
    expect(mocks.reports).toHaveLength(0);
  });

  it("reports a code-less 404 as a failure with its status", async () => {
    mocks.send.mockRejectedValue(s3Error("NotFound", 404));
    await storage.deleteFileBestEffort("docs/a.pdf", "session-expiry");
    expect(mocks.reports).toHaveLength(1);
    expect(diagnosticErrorTags(mocks.reports[0]!.error)).toMatchObject({
      storage_operation: "delete",
      dependency_status: 404,
    });
  });

  it("reports a real failure with its operation and failure code", async () => {
    mocks.send.mockRejectedValue(connectionRefused());
    await storage.deleteFileBestEffort("k", "session-expiry");
    expect(mocks.reports).toHaveLength(1);
    const [{ error }] = mocks.reports;
    expect(error).toBeInstanceOf(storage.StorageOperationError);
    expect(diagnosticErrorTags(error)).toEqual({
      storage_operation: "delete",
      failure_code: "ECONNREFUSED",
    });
  });

  it("reports ONE warning per operation however many keys fail", async () => {
    mocks.send.mockRejectedValue(s3Error("InvalidAccessKeyId", 403));
    await storage.deleteFilesBestEffort(
      ["uploads/staging/k", "uploads/sealed/k"],
      "seal-recover",
    );
    expect(mocks.send).toHaveBeenCalledTimes(2); // both still attempted
    expect(mocks.reports).toHaveLength(1);
    expect(mocks.reports[0]!.what).toBe("storage-delete:seal-recover");
    expect(diagnosticErrorTags(mocks.reports[0]!.error)).toMatchObject({
      storage_operation: "delete",
      failure_code: "InvalidAccessKeyId",
      dependency_status: 403,
    });
  });

  it("skips null and empty keys without a request or a report", async () => {
    mocks.send.mockResolvedValue({});
    await storage.deleteFilesBestEffort([null, "", undefined, "k"], "session-expiry");
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.reports).toHaveLength(0);
  });
});
