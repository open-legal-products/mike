import { beforeAll, describe, expect, it, vi } from "vitest";

// Exercises the real AWS SDK signer: presigning is offline, so the host of the
// returned URL is exactly what the browser will be sent to.
let getSignedUrl: typeof import("../storage").getSignedUrl;

beforeAll(async () => {
  process.env.R2_ENDPOINT_URL = "http://storage:9000";
  process.env.R2_PUBLIC_ENDPOINT_URL = "https://files.example.test";
  process.env.R2_ACCESS_KEY_ID = "test-access-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
  process.env.R2_BUCKET_NAME = "mike";
  vi.resetModules();
  ({ getSignedUrl } = await import("../storage.js"));
});

describe("signed download URLs", () => {
  it("point at the browser-reachable endpoint, not the internal one", async () => {
    const url = await getSignedUrl("documents/u1/d1/file.docx", 3600, "file.docx");

    expect(url).toBeTruthy();
    const parsed = new URL(url!);
    expect(parsed.origin).toBe("https://files.example.test");
    expect(parsed.pathname).toBe("/mike/documents/u1/d1/file.docx");
    expect(parsed.searchParams.get("response-content-disposition")).toContain(
      "file.docx",
    );
  });
});
