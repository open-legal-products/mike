import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseStorageAdapter, isMissingObject } from "../storage/supabase";

type Call = { url: URL; method: string; headers: Headers; body: unknown };

let calls: Call[];
let respond: (call: Call) => Response;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  process.env.SUPABASE_URL = "https://project.supabase.test";
  process.env.SUPABASE_SECRET_KEY = "service-role-key";
  delete process.env.SUPABASE_STORAGE_BUCKET;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const call: Call = {
        url: new URL(request ? request.url : String(input)),
        method: init?.method ?? request?.method ?? "GET",
        headers: new Headers(init?.headers ?? request?.headers),
        body: init?.body,
      };
      calls.push(call);
      return respond(call);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
});

describe("isMissingObject", () => {
  it("recognises Supabase's missing-object answers", () => {
    expect(isMissingObject({ status: 400, statusCode: "404", message: "Object not found" })).toBe(true);
    expect(isMissingObject({ status: 404, code: "NoSuchKey" })).toBe(true);
  });

  it("keeps a missing bucket and other failures as errors", () => {
    expect(isMissingObject({ status: 400, statusCode: "404", message: "Bucket not found" })).toBe(false);
    expect(isMissingObject({ status: 404, code: "NoSuchBucket" })).toBe(false);
    expect(isMissingObject({ status: 403, statusCode: "403", message: "invalid signature" })).toBe(false);
    expect(isMissingObject(null)).toBe(false);
  });
});

describe("Supabase storage adapter", () => {
  it("is enabled only with a project URL and secret key", () => {
    expect(createSupabaseStorageAdapter().enabled).toBe(true);
    delete process.env.SUPABASE_SECRET_KEY;
    expect(createSupabaseStorageAdapter().enabled).toBe(false);
  });

  it("uploads with the secret key, upsert and the declared type", async () => {
    respond = () => json(200, { Key: "mike/documents/u/d/source.pdf" });
    await createSupabaseStorageAdapter().uploadFile(
      "documents/u/d/source.pdf",
      new Uint8Array([1, 2, 3]).buffer,
      "application/pdf",
    );
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url.pathname).toBe("/storage/v1/object/mike/documents/u/d/source.pdf");
    expect(call.headers.get("authorization")).toBe("Bearer service-role-key");
    expect(call.headers.get("x-upsert")).toBe("true");
    expect(call.headers.get("content-type")).toBe("application/pdf");
  });

  it("maps object info to metadata and a missing object to null", async () => {
    respond = (call) =>
      call.url.pathname.endsWith("/present.pdf")
        ? json(200, { size: 12, content_type: "application/pdf", etag: '"e"' })
        : json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    const adapter = createSupabaseStorageAdapter();
    await expect(adapter.headFile("present.pdf")).resolves.toEqual({
      size: 12,
      etag: '"e"',
      contentType: "application/pdf",
    });
    await expect(adapter.headFile("absent.pdf")).resolves.toBeNull();
    expect(calls[0].url.pathname).toBe("/storage/v1/object/info/mike/present.pdf");
  });

  it("returns null when downloading a missing object and throws for a missing bucket", async () => {
    const adapter = createSupabaseStorageAdapter();
    respond = () => json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    await expect(adapter.downloadFile("absent.pdf")).resolves.toBeNull();
    respond = () => json(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
    await expect(adapter.downloadFile("absent.pdf")).rejects.toThrow("Bucket not found");
  });

  it("streams an object body", async () => {
    respond = () => new Response(new Uint8Array([7, 8, 9]));
    const stream = await createSupabaseStorageAdapter().openReadStream("a.txt");
    const chunks: number[] = [];
    for await (const chunk of stream!) chunks.push(...chunk);
    expect(chunks).toEqual([7, 8, 9]);
    expect(calls[0].url.pathname).toBe("/storage/v1/object/authenticated/mike/a.txt");
  });

  it("signs attachment downloads with the filename and inline ones without", async () => {
    respond = () => json(200, { signedURL: "/object/sign/mike/a.pdf?token=t" });
    const adapter = createSupabaseStorageAdapter();
    const attachment = await adapter.getSignedUrl(
      "a.pdf",
      60,
      'attachment; filename="Report.pdf"',
      "Report.pdf",
    );
    expect(new URL(attachment!).searchParams.get("download")).toBe("Report.pdf");
    const inline = await adapter.getSignedUrl("a.pdf", 60);
    expect(new URL(inline!).searchParams.has("download")).toBe(false);
  });

  it("returns a signed upload URL for the browser", async () => {
    respond = () => json(200, { url: "/object/upload/sign/mike/staging/x.pdf?token=up" });
    const url = await createSupabaseStorageAdapter().getSignedUploadUrl(
      "staging/x.pdf",
      "application/pdf",
      3,
      900,
    );
    expect(url).toContain("/storage/v1/object/upload/sign/mike/staging/x.pdf");
    expect(new URL(url!).searchParams.get("token")).toBe("up");
  });

  it("lists every key under a prefix across pages", async () => {
    respond = (call) => {
      const body = JSON.parse(String(call.body)) as { cursor?: string };
      return body.cursor
        ? json(200, { hasNext: false, folders: [], objects: [{ name: "c", key: "p/c" }] })
        : json(200, {
            hasNext: true,
            nextCursor: "next",
            folders: [],
            objects: [{ name: "a", key: "p/a" }, { name: "b", key: "p/b" }],
          });
    };
    await expect(createSupabaseStorageAdapter().listFiles("p/")).resolves.toEqual([
      "p/a",
      "p/b",
      "p/c",
    ]);
  });

  it("copies without touching the target, and replaces it only when it already exists", async () => {
    const adapter = createSupabaseStorageAdapter();
    respond = () => json(200, { Key: "mike/b" });
    await adapter.copyFile("a", "b");
    expect(calls.map((c) => c.url.pathname)).toEqual(["/storage/v1/object/copy"]);

    calls = [];
    let copies = 0;
    respond = (call) => {
      if (call.url.pathname === "/storage/v1/object/copy") {
        copies += 1;
        return copies === 1
          ? json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" })
          : json(200, { Key: "mike/b" });
      }
      return json(200, [{ name: "b" }]);
    };
    await adapter.copyFile("a", "b");
    expect(calls.map((c) => c.url.pathname)).toEqual([
      "/storage/v1/object/copy",
      "/storage/v1/object/mike",
      "/storage/v1/object/copy",
    ]);
  });

  it("never deletes the target when a copy fails for another reason", async () => {
    respond = () => json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
    await expect(createSupabaseStorageAdapter().copyFile("missing", "b")).rejects.toThrow();
    expect(calls.map((c) => c.method)).toEqual(["POST"]);
  });

  it("treats deleting a missing key as done but a failed delete as an error", async () => {
    const adapter = createSupabaseStorageAdapter();
    respond = () => json(200, []);
    await expect(adapter.deleteFile("absent.pdf")).resolves.toBeUndefined();
    respond = () => json(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found" });
    await expect(adapter.deleteFile("absent.pdf")).rejects.toThrow();
  });
});
