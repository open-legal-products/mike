import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
  clientConfigs: [] as Array<Record<string, unknown>>,
  reportError: vi.fn(),
}));

// Pass through: the real reportError marks the object as reported, which is
// what lets the console bridge skip the log line that follows it.
vi.mock("../observability/sentry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../observability/sentry")>();
  mocks.reportError.mockImplementation(actual.reportError);
  return { ...actual, reportError: mocks.reportError };
});

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    constructor(config: Record<string, unknown>) {
      mocks.clientConfigs.push(config);
    }
    send = mocks.send;
  }
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client,
    PutObjectCommand: Command,
    DeleteObjectCommand: Command,
    ListObjectsV2Command: Command,
    GetObjectCommand: Command,
    HeadObjectCommand: Command,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mocks.getSignedUrl,
}));

let downloadFile: typeof import("../storage").downloadFile;
let createFileReadStream: typeof import("../storage").createFileReadStream;
let getSignedUrl: typeof import("../storage").getSignedUrl;
let getSignedUploadUrl: typeof import("../storage").getSignedUploadUrl;
let headFile: typeof import("../storage").headFile;
let uploadFileFromPath: typeof import("../storage").uploadFileFromPath;

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://r2.example.test";
  process.env.R2_PUBLIC_ENDPOINT_URL = "";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  vi.resetModules();
  ({
    createFileReadStream,
    downloadFile,
    getSignedUploadUrl,
    getSignedUrl,
    headFile,
    uploadFileFromPath,
  } = await import("../storage.js"));
});

beforeEach(() => {
  mocks.send.mockReset();
  mocks.getSignedUrl.mockReset();
  mocks.reportError.mockClear();
  mocks.clientConfigs.length = 0;
});

describe("storage error logging", () => {
  it("uses the internal endpoint when the public upload endpoint is blank", async () => {
    mocks.getSignedUrl.mockResolvedValue("https://signed.example.test");

    await expect(
      getSignedUploadUrl("documents/u1/d1/source.pdf", "application/pdf", 1_234),
    ).resolves.toBe("https://signed.example.test");

    expect(mocks.clientConfigs.at(-1)).toMatchObject({
      endpoint: "https://r2.example.test",
    });
  });

  it("does not open an R2 GET until the returned stream is consumed", async () => {
    mocks.send.mockResolvedValue({
      Body: Readable.from([Buffer.from("first "), Buffer.from("second")]),
    });

    const stream = createFileReadStream("documents/u1/d1/source.pdf");
    expect(mocks.send).not.toHaveBeenCalled();

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString()).toBe("first second");
    expect(mocks.send).toHaveBeenCalledTimes(1);
  });

  it("uploads a local file as a stream with an explicit content length", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mike-storage-test-"));
    const filePath = join(directory, "converted.pdf");
    await writeFile(filePath, Buffer.from("streamed pdf"));
    let uploaded = Buffer.alloc(0);
    mocks.send.mockImplementation(async (command: unknown) => {
      const input = (
        command as {
          input: {
            Body: Readable;
            ContentLength: number;
            ContentType: string;
          };
        }
      ).input;
      const chunks: Buffer[] = [];
      for await (const chunk of input.Body) chunks.push(Buffer.from(chunk));
      uploaded = Buffer.concat(chunks);
      expect(input.ContentLength).toBe(12);
      expect(input.ContentType).toBe("application/pdf");
      return {};
    });

    try {
      await uploadFileFromPath(
        "converted-pdfs/user/document.pdf",
        filePath,
        "application/pdf",
      );
      expect(uploaded.toString()).toBe("streamed pdf");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  // The absorbed failures (the caller gets null) are reported here, once,
  // with the storage kind and the SDK's error as the cause, and the console
  // line carries the SAME object so the bridge files no second event.
  it("reports and logs download failures with the object key and the kind", async () => {
    const failure = Object.assign(new Error("download failed"), {
      name: "NoSuchKey",
    });
    mocks.send.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      downloadFile("documents/u1/d1/source.pdf"),
    ).resolves.toBeNull();

    expect(mocks.reportError).toHaveBeenCalledOnce();
    const [reported, context] = mocks.reportError.mock.calls[0]!;
    expect(diagnosticErrorTags(reported)).toEqual({
      error_kind: "storage.download_failed",
      storage_operation: "download",
      failure_code: "NoSuchKey",
    });
    expect(context).toMatchObject({ tags: { component: "storage" } });
    expect(log).toHaveBeenCalledWith("[storage] downloadFile failed", {
      key: "documents/u1/d1/source.pdf",
      error: reported,
    });
    expect((reported as Error).cause).toBe(failure);
    log.mockRestore();
  });

  it.each([
    ["getSignedUrl", () => getSignedUrl("documents/u1/d1/source.pdf")],
    [
      "getSignedUploadUrl",
      () =>
        getSignedUploadUrl(
          "documents/u1/d1/source.pdf",
          "application/pdf",
          1_234,
        ),
    ],
  ])("reports and logs %s failures with the object key and the kind", async (label, sign) => {
    const failure = new Error("signing failed");
    mocks.getSignedUrl.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sign()).resolves.toBeNull();

    expect(mocks.reportError).toHaveBeenCalledOnce();
    const [reported, context] = mocks.reportError.mock.calls[0]!;
    expect(diagnosticErrorTags(reported)).toEqual({
      error_kind: "storage.signed_url_failed",
    });
    expect(context).toMatchObject({ tags: { component: "storage" } });
    expect(log).toHaveBeenCalledWith(`[storage] ${label} failed`, {
      key: "documents/u1/d1/source.pdf",
      error: reported,
    });
    expect((reported as Error).cause).toBe(failure);
    log.mockRestore();
  });

  // Thrown failures are reported by whoever catches them; a console line
  // here filed the same failure a second, context-free time.
  it("throws HEAD failures without logging them first", async () => {
    mocks.send.mockRejectedValue(new Error("head failed"));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const thrown = await headFile("documents/u1/d1/source.pdf").catch(
      (error: unknown) => error,
    );

    expect(diagnosticErrorTags(thrown)).toEqual({
      error_kind: "storage.head_failed",
      storage_operation: "HEAD",
    });
    expect(log).not.toHaveBeenCalled();
    expect(mocks.reportError).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
