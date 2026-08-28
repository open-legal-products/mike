import { beforeAll, describe, expect, it, vi } from "vitest";

// Exercises the real AWS SDK signer: presigning is offline, so this catches
// query parameters the SDK adds on its own.
let getSignedUploadUrl: typeof import("../storage").getSignedUploadUrl;

function signedHeaders(url: string): string {
  return new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
}

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "https://account.r2.cloudflarestorage.com";
  process.env.R2_PUBLIC_ENDPOINT_URL = "";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET_NAME = "mike";
  vi.resetModules();
  ({ getSignedUploadUrl } = await import("../storage"));
});

describe("signed direct-upload URLs", () => {
  it("does not carry a checksum computed over the empty signable body", async () => {
    const url = await getSignedUploadUrl(
      "upload-sessions/u1/s1/f1/staging",
      "application/pdf",
      1_234,
    );

    expect(url).toBeTruthy();
    const parameters = new URL(url!).searchParams;
    expect(parameters.get("x-amz-checksum-crc32")).toBeNull();
    expect(parameters.get("x-amz-sdk-checksum-algorithm")).toBeNull();
  });

  it("signs the declared content type and byte count", async () => {
    const url = await getSignedUploadUrl(
      "upload-sessions/u1/s1/f1/staging",
      "application/pdf",
      1_234,
    );

    expect(signedHeaders(url!)).toBe("content-length;content-type;host");
  });

  it("produces a different signature for a different declared size", async () => {
    const [small, large] = await Promise.all([
      getSignedUploadUrl("upload-sessions/u1/s1/f1/staging", "application/pdf", 1_024),
      getSignedUploadUrl("upload-sessions/u1/s1/f1/staging", "application/pdf", 5_000_000),
    ]);

    expect(new URL(small!).searchParams.get("X-Amz-Signature")).not.toBe(
      new URL(large!).searchParams.get("X-Amz-Signature"),
    );
  });
});
