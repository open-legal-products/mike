import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  getSignedUrl: vi.fn(),
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
    DeleteObjectCommand: Command,
    ListObjectsV2Command: Command,
    GetObjectCommand: Command,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mocks.getSignedUrl,
}));

let downloadFile: typeof import("../storage").downloadFile;
let getSignedUrl: typeof import("../storage").getSignedUrl;

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://r2.example.test";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  vi.resetModules();
  ({ downloadFile, getSignedUrl } = await import("../storage.js"));
});

beforeEach(() => {
  mocks.send.mockReset();
  mocks.getSignedUrl.mockReset();
});

describe("storage error logging", () => {
  it("logs download failures with the object key and a safe error", async () => {
    const failure = new Error("download failed");
    mocks.send.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      downloadFile("documents/u1/d1/source.pdf"),
    ).resolves.toBeNull();

    expect(log).toHaveBeenCalledWith("[storage] downloadFile failed", {
      key: "documents/u1/d1/source.pdf",
      error: expect.objectContaining({
        name: "Error",
        message: "download failed",
      }),
    });
    log.mockRestore();
  });

  it("logs signed-URL failures with the object key and a safe error", async () => {
    const failure = new Error("signing failed");
    mocks.getSignedUrl.mockRejectedValue(failure);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      getSignedUrl("documents/u1/d1/source.pdf"),
    ).resolves.toBeNull();

    expect(log).toHaveBeenCalledWith("[storage] getSignedUrl failed", {
      key: "documents/u1/d1/source.pdf",
      error: expect.objectContaining({
        name: "Error",
        message: "signing failed",
      }),
    });
    log.mockRestore();
  });
});
