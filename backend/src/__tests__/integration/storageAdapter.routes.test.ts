import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// End-to-end proof that the StorageAdapter seam is the only path a route takes
// to object storage. `lib/storage` is deliberately NOT mocked here: the real
// facade runs, and the only backend it can reach is the in-memory adapter
// registered below. The S3 SDK is replaced with a tripwire, and the R2_* env
// vars are cleared before any import, so the default S3 adapter is disabled
// and any request that slipped past the seam would fail loudly.

const mocks = vi.hoisted(() => {
  for (const name of [
    "R2_ENDPOINT_URL",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_PUBLIC_ENDPOINT_URL",
  ]) {
    delete process.env[name];
  }
  return {
    ensureDocAccess: vi.fn(),
    loadActiveVersion: vi.fn(),
    s3Send: vi.fn(async () => {
      throw new Error("S3 must not be reached when an adapter is registered");
    }),
  };
});

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = mocks.s3Send;
    },
  };
});

const database = {
  from: vi.fn(() => {
    const query: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) {
      query[method] = vi.fn(() => query);
    }
    query.single = vi.fn(async () => ({
      data: {
        id: "document-1",
        user_id: "user-1",
        project_id: null,
        org_id: null,
        workflow_id: null,
      },
      error: null,
    }));
    return query;
  }),
};

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "user-1";
    res.locals.userEmail = "user@example.com";
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: vi.fn(() => database),
}));

vi.mock("../../lib/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/access")>()),
  ensureDocAccess: mocks.ensureDocAccess,
}));

vi.mock("../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/documentVersions")>()),
  loadActiveVersion: mocks.loadActiveVersion,
}));

import {
  setStorageAdapter,
  storageEnabled,
  type StorageAdapter,
} from "../../lib/storage";
import { documentsRouter } from "../../modules/documents/documents.routes";

const SOURCE_KEY = "documents/user-1/document-1/contrat-é.docx";

/** A complete second backend in a few lines: objects live in a Map. */
function inMemoryAdapter(objects: Map<string, Uint8Array>) {
  const adapter: StorageAdapter = {
    enabled: true,
    configurationHint: "in-memory adapter is always configured",
    uploadFile: vi.fn(async (key, content) => {
      objects.set(key, new Uint8Array(content));
    }),
    uploadFileFromPath: vi.fn(async () => undefined),
    getSignedUploadUrl: vi.fn(async () => null),
    downloadFile: vi.fn(async (key) => {
      const bytes = objects.get(key);
      return bytes ? (bytes.slice().buffer as ArrayBuffer) : null;
    }),
    openReadStream: vi.fn(async (key) => {
      const bytes = objects.get(key);
      return bytes
        ? (async function* () {
            yield bytes;
          })()
        : null;
    }),
    headFile: vi.fn(async (key) => {
      const bytes = objects.get(key);
      return bytes
        ? { size: bytes.byteLength, etag: null, contentType: null }
        : null;
    }),
    listFiles: vi.fn(async (prefix) =>
      [...objects.keys()].filter((key) => key.startsWith(prefix)),
    ),
    copyFile: vi.fn(async () => undefined),
    deleteFile: vi.fn(async (key) => {
      objects.delete(key);
    }),
    getSignedUrl: vi.fn(async () => null),
  };
  return adapter;
}

const app = express();
app.use("/single-documents", documentsRouter);

describe("documents file route on a registered StorageAdapter", () => {
  let objects: Map<string, Uint8Array>;
  let adapter: StorageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    objects = new Map([[SOURCE_KEY, new Uint8Array([0x50, 0x4b, 0x03, 0x04])]]);
    adapter = inMemoryAdapter(objects);
    setStorageAdapter(adapter);
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-1",
      storage_path: SOURCE_KEY,
      pdf_storage_path: null,
      version_number: 1,
      filename: "contrat-é.docx",
      source: "user_upload",
      file_type: "docx",
      size_bytes: 4,
      page_count: null,
    });
  });

  it("starts with the default S3 adapter disabled", () => {
    // Guards the premise of every test below: without the registered adapter
    // there is no configured backend for the route to fall back to.
    vi.resetModules();
    return import("../../lib/storage.js").then((fresh) => {
      expect(fresh.storageEnabled).toBe(false);
    });
  });

  it("serves the object's bytes from the adapter, never from S3", async () => {
    expect(storageEnabled).toBe(true);

    const response = await request(app)
      .get("/single-documents/document-1/file")
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect([...(response.body as Buffer)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(response.headers["content-length"]).toBe("4");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(adapter.headFile).toHaveBeenCalledWith(SOURCE_KEY);
    expect(adapter.openReadStream).toHaveBeenCalledWith(SOURCE_KEY);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it("answers 404 when the adapter reports the object missing", async () => {
    objects.clear();

    const response = await request(app).get("/single-documents/document-1/file");

    expect(response.status).toBe(404);
    expect(adapter.headFile).toHaveBeenCalledWith(SOURCE_KEY);
    expect(adapter.openReadStream).not.toHaveBeenCalled();
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it("does not touch the adapter when the caller cannot access the document", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: false });

    const response = await request(app).get("/single-documents/document-1/file");

    expect(response.status).toBe(404);
    expect(adapter.headFile).not.toHaveBeenCalled();
    expect(adapter.openReadStream).not.toHaveBeenCalled();
  });
});
