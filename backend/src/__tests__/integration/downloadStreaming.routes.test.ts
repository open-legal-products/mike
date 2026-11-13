import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The download routes hand the object to the client as a stream. These cases
// drive the real router and storage facade against a scripted adapter, so each
// one controls exactly when the store yields, fails, or stalls. The signed
// (filesystem-driver) route is used because its token is the only input; the
// authenticated route shares the same response helper.

vi.hoisted(() => {
  process.env.DOWNLOAD_SIGNING_SECRET = "test-signing-secret";
  process.env.STORAGE_DOWNLOAD_TIMEOUT_MS = "10000";
});

import { setStorageAdapter, type StorageAdapter } from "../../lib/storage";
import { signBlobToken } from "../../lib/downloadTokens";
import { downloadsRouter } from "../../modules/downloads/downloads.routes";

const KEY = "documents/u1/d1/source.pdf";
const FIRST = Buffer.from("first chunk;");
const SECOND = Buffer.from("second chunk");
const SIZE = FIRST.length + SECOND.length;

type Reader = (signal: AbortSignal | undefined) => AsyncIterable<Uint8Array>;

function adapterReading(reader: Reader): StorageAdapter {
  return {
    enabled: true,
    configurationHint: "scripted adapter",
    uploadFile: vi.fn(),
    uploadFileFromPath: vi.fn(),
    getSignedUploadUrl: vi.fn(),
    downloadFile: vi.fn(async () => {
      throw new Error("a download must not buffer the whole object");
    }),
    openReadStream: vi.fn(async (_key, options) => reader(options?.signal)),
    headFile: vi.fn(async () => ({ size: SIZE, etag: '"v1"', contentType: null })),
    listFiles: vi.fn(),
    copyFile: vi.fn(),
    deleteFile: vi.fn(),
    getSignedUrl: vi.fn(),
  };
}

const app = express();
app.use("/download", downloadsRouter);
let server: http.Server;
let base: string;
const path = () => `/download/signed/${signBlobToken(KEY, "report.pdf", 60)}`;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** GET over a real socket, calling `onChunk` as each body chunk arrives. */
function get(onChunk: (chunk: Buffer, req: http.ClientRequest) => void) {
  return new Promise<{ status: number; length: string | undefined; body: Buffer; complete: boolean }>(
    (resolve) => {
      const chunks: Buffer[] = [];
      const req = http.get(base + path(), (res) => {
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            length: res.headers["content-length"],
            body: Buffer.concat(chunks),
            complete: res.complete,
          });
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          onChunk(chunk, req);
        });
        res.on("end", done);
        res.on("close", done);
        res.on("error", () => undefined);
      });
      req.on("error", () => undefined);
    },
  );
}

describe("GET /download/signed/:token streaming", () => {
  it("sends the first chunk before the store has produced the rest", async () => {
    let clientHasFirst!: () => void;
    const firstArrived = new Promise<void>((resolve) => (clientHasFirst = resolve));
    setStorageAdapter(
      adapterReading(async function* () {
        yield FIRST;
        // A buffered response would wait here forever: the client only
        // releases the rest once it has received the first chunk.
        await firstArrived;
        yield SECOND;
      }),
    );

    const res = await get(() => clientHasFirst());

    expect(res.status).toBe(200);
    expect(res.length).toBe(String(SIZE));
    expect(res.body.toString()).toBe("first chunk;second chunk");
  });

  it("answers a store that fails before the first byte with an error status", async () => {
    setStorageAdapter(
      adapterReading(async function* () {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      }),
    );

    const res = await request(app).get(path());

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("internal_error");
    expect(res.headers["content-disposition"]).toBeUndefined();
    // The object's validator must not be attached to the error body.
    expect(res.headers.etag).not.toBe('"v1"');
  });

  it("answers a matching If-None-Match with 304 without reading the object", async () => {
    const adapter = adapterReading(async function* () {
      yield FIRST;
      yield SECOND;
    });
    setStorageAdapter(adapter);

    const full = await request(app).get(path());
    expect(full.status).toBe(200);
    expect(full.headers.etag).toBe('"v1"');
    vi.mocked(adapter.openReadStream).mockClear();

    const revalidated = await request(app).get(path()).set("If-None-Match", '"v1"');
    expect(revalidated.status).toBe(304);
    expect(adapter.openReadStream).not.toHaveBeenCalled();
  });

  it("cancels the storage read when the client disconnects", async () => {
    let released!: (reason: unknown) => void;
    const storageReleased = new Promise((resolve) => (released = resolve));
    setStorageAdapter(
      adapterReading(async function* (signal) {
        yield FIRST;
        // Stall like a slow store; only an abort lets this read go.
        await new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => {
            released(signal.reason);
            reject(signal.reason);
          }),
        );
      }),
    );

    await get((_chunk, req) => req.destroy());

    await expect(storageReleased).resolves.toBeDefined();
  });

  it("ends the response short and releases the store when a read fails mid-stream", async () => {
    let finished = false;
    setStorageAdapter(
      adapterReading(async function* () {
        try {
          yield FIRST;
          throw new Error("socket hang up");
        } finally {
          finished = true;
        }
      }),
    );

    const res = await get(() => undefined);

    expect(res.status).toBe(200);
    expect(res.complete).toBe(false);
    expect(res.body.length).toBeLessThan(SIZE);
    expect(finished).toBe(true);
  });
});
