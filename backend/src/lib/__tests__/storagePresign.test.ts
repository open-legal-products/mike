import { describe, expect, it, vi } from "vitest";

// These tests intentionally do NOT mock @aws-sdk/s3-request-presigner: the
// behavior under test is which endpoint the real presigner signs against.
// Presigning is pure local crypto (no network), so letting the real SDK
// produce the URL and parsing its host keeps the test honest — a mock would
// happily "sign" against whatever client the code handed it.
//
// PRESIGN_ENDPOINT is captured at module load in ../storage, so each case
// must configure process.env BEFORE importing a fresh copy of the module
// (same reset-then-dynamic-import pattern as storageErrors.test.ts).
async function loadStorage(publicEndpoint?: string) {
  vi.resetModules();
  process.env.R2_ENDPOINT_URL = "http://storage:9000";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET_NAME = "mike";
  if (publicEndpoint === undefined) {
    delete process.env.R2_PUBLIC_ENDPOINT_URL;
  } else {
    process.env.R2_PUBLIC_ENDPOINT_URL = publicEndpoint;
  }
  return import("../storage");
}

describe("getSignedUrl presign endpoint split", () => {
  it("signs against R2_PUBLIC_ENDPOINT_URL, not the internal endpoint", async () => {
    // Self-hosted deploys reach storage at a compose-internal hostname
    // (http://storage:9000) that a browser can never resolve. The presigned
    // URL is handed to the browser, so it must be signed against the
    // host-published endpoint — and an S3 signature is bound to the host it
    // was signed for, so this cannot be fixed up after the fact.
    const { getSignedUrl } = await loadStorage("http://localhost:9100");

    const url = await getSignedUrl("some/key");

    expect(url).not.toBeNull();
    const parsed = new URL(url!);
    expect(parsed.host).toBe("localhost:9100");
    expect(parsed.host).not.toBe("storage:9000");
    // Still a real path-style presigned GET for the requested object.
    expect(parsed.pathname).toBe("/mike/some/key");
    expect(parsed.searchParams.get("X-Amz-Signature")).toBeTruthy();
  });

  it("falls back to the R2_ENDPOINT_URL host when no public endpoint is set", async () => {
    // Cloud R2/S3 endpoints are already publicly reachable; without
    // R2_PUBLIC_ENDPOINT_URL the presigner must keep using the one
    // configured endpoint unchanged.
    const { getSignedUrl } = await loadStorage(undefined);

    const url = await getSignedUrl("some/key");

    expect(url).not.toBeNull();
    expect(new URL(url!).host).toBe("storage:9000");
  });
});
