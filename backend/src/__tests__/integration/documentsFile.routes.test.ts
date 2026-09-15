import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createFileReadStream: vi.fn(),
  downloadFile: vi.fn(),
  ensureDocAccess: vi.fn(),
  headFile: vi.fn(),
  loadActiveVersion: vi.fn(),
}));

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

vi.mock("../../lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/storage")>()),
  createFileReadStream: mocks.createFileReadStream,
  downloadFile: mocks.downloadFile,
  headFile: mocks.headFile,
}));

import { documentsRouter } from "../../modules/documents/documents.routes";

const app = express();
app.use("/single-documents", documentsRouter);

describe("GET /single-documents/:documentId/file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, isCreator: true });
    mocks.loadActiveVersion.mockResolvedValue({
      id: "version-2",
      storage_path: "documents/user-1/document-1/source.xlsx",
      pdf_storage_path: "converted-pdfs/user-1/document-1/version-2.pdf",
      version_number: 2,
      filename: "financials.xlsx",
      source: "user_upload",
      file_type: "xlsx",
      size_bytes: 3,
      page_count: null,
    });
    mocks.headFile.mockResolvedValue({
      size: 3,
      etag: '"etag"',
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    mocks.createFileReadStream.mockImplementation(() =>
      Readable.from([Buffer.from([0x50, 0x4b, 0x03])]),
    );
  });

  it("streams the requested version's source bytes with its actual file type", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/file?version_id=version-2")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["content-disposition"]).toContain(
      "financials.xlsx",
    );
    expect(response.headers["content-length"]).toBe("3");
    expect(mocks.loadActiveVersion).toHaveBeenCalledWith(
      "document-1",
      database,
      "version-2",
    );
    expect(mocks.headFile).toHaveBeenCalledWith(
      "documents/user-1/document-1/source.xlsx",
    );
    expect(mocks.createFileReadStream).toHaveBeenCalledWith(
      "documents/user-1/document-1/source.xlsx",
    );
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("does not read storage when the caller cannot access the document", async () => {
    mocks.ensureDocAccess.mockResolvedValue({ ok: false });

    const response = await request(app)
      .get("/single-documents/document-1/file")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document not found" });
    expect(mocks.loadActiveVersion).not.toHaveBeenCalled();
    expect(mocks.headFile).not.toHaveBeenCalled();
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("returns 404 without opening a stream when the source object is missing", async () => {
    mocks.headFile.mockResolvedValue(null);

    const response = await request(app)
      .get("/single-documents/document-1/file")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document bytes not available" });
    expect(mocks.createFileReadStream).not.toHaveBeenCalled();
    expect(mocks.downloadFile).not.toHaveBeenCalled();
  });

  it("does not retain the old format-specific route", async () => {
    const response = await request(app)
      .get("/single-documents/document-1/docx")
      .set("Authorization", "Bearer test");

    expect(response.status).toBe(404);
    expect(mocks.loadActiveVersion).not.toHaveBeenCalled();
  });
});
