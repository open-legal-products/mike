import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  from,
  deleteFile,
  downloadFile,
  getSignedUploadUrl,
  headFile,
  importPlaybookFromDocx,
} = vi.hoisted(() => ({
  from: vi.fn(),
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  headFile: vi.fn(),
  importPlaybookFromDocx: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ from }),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "u1";
    next();
  },
  requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

vi.mock("../../lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/storage")>();
  return {
    ...actual,
    storageEnabled: true,
    deleteFile,
    downloadFile,
    getSignedUploadUrl,
    headFile,
  };
});

vi.mock("../../lib/playbooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/playbooks")>();
  return { ...actual, importPlaybookFromDocx };
});

import { playbooksRouter } from "../../routes/playbooks";
import { PlaybookRequestError } from "../../lib/playbooks";

const app = express();
app.use(express.json());
app.use("/playbooks", playbooksRouter);

function queryReturning(data: unknown) {
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "order",
    "in",
  ]) {
    query[method] = vi.fn(() => query);
  }
  query.single = vi.fn(async () => ({ data, error: null }));
  query.maybeSingle = vi.fn(async () => ({ data, error: null }));
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => Promise.resolve({ data, error: null }).then(resolve, reject);
  return query;
}

describe("playbook import upload staging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSignedUploadUrl.mockResolvedValue("https://storage.example/put");
    headFile.mockResolvedValue({
      size: 2048,
      etag: null,
      contentType: null,
    });
    downloadFile.mockResolvedValue(new TextEncoder().encode("docx").buffer);
    deleteFile.mockResolvedValue(undefined);
  });

  it("signs an upload under the caller's own prefix", async () => {
    const response = await request(app)
      .post("/playbooks/import/upload-url")
      .send({ filename: "playbook.docx", sizeBytes: 2048 });

    expect(response.status).toBe(201);
    expect(response.body.storageKey).toMatch(/^playbooks\/u1\/imports\//);
    expect(response.body.uploadUrl).toBe("https://storage.example/put");
    expect(getSignedUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(/^playbooks\/u1\/imports\/.+\.docx$/),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      2048,
      900,
    );
  });

  it("rejects a file that is not a .docx", async () => {
    const response = await request(app)
      .post("/playbooks/import/upload-url")
      .send({ filename: "playbook.pdf", sizeBytes: 2048 });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/\.docx/);
    expect(getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects an implausible size before signing anything", async () => {
    const response = await request(app)
      .post("/playbooks/import/upload-url")
      .send({ filename: "playbook.docx", sizeBytes: 200 * 1024 * 1024 });

    expect(response.status).toBe(400);
    expect(getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("refuses to compile an object staged by another account", async () => {
    const response = await request(app)
      .post("/playbooks/import")
      .send({ storageKey: "playbooks/u2/imports/abc.docx", model: "gpt-5.4" });

    expect(response.status).toBe(400);
    expect(headFile).not.toHaveBeenCalled();
    expect(importPlaybookFromDocx).not.toHaveBeenCalled();
  });

  it("refuses a storage key outside the import prefix", async () => {
    const response = await request(app)
      .post("/playbooks/import")
      .send({ storageKey: "documents/u1/secret.docx", model: "gpt-5.4" });

    expect(response.status).toBe(400);
    expect(downloadFile).not.toHaveBeenCalled();
  });

  it("compiles a staged upload and clears the staged object", async () => {
    importPlaybookFromDocx.mockResolvedValue({ id: "pb1", name: "Imported" });

    const response = await request(app).post("/playbooks/import").send({
      storageKey: "playbooks/u1/imports/abc.docx",
      filename: "playbook.docx",
      model: "gpt-5.4",
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: "pb1" });
    expect(importPlaybookFromDocx).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", filename: "playbook.docx" }),
    );
    expect(deleteFile).toHaveBeenCalledWith("playbooks/u1/imports/abc.docx");
  });

  it("clears the staged object even when compilation fails", async () => {
    importPlaybookFromDocx.mockRejectedValue(
      new PlaybookRequestError("Select a model."),
    );

    const response = await request(app).post("/playbooks/import").send({
      storageKey: "playbooks/u1/imports/abc.docx",
      model: "",
    });

    expect(response.status).toBe(400);
    expect(response.body.detail).toBe("Select a model.");
    expect(deleteFile).toHaveBeenCalledWith("playbooks/u1/imports/abc.docx");
  });

  it("reports a staged object that expired before the import ran", async () => {
    headFile.mockResolvedValue(null);

    const response = await request(app)
      .post("/playbooks/import")
      .send({ storageKey: "playbooks/u1/imports/abc.docx", model: "gpt-5.4" });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/no longer available/i);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

describe("playbook error boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not leak an internal failure to the client", async () => {
    from.mockImplementation(() => {
      throw new Error("connection to db-primary.internal refused");
    });

    const response = await request(app).get("/playbooks");

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("internal_error");
    expect(JSON.stringify(response.body)).not.toMatch(/db-primary/);
  });

  it("returns 404 for a playbook the caller does not own", async () => {
    from.mockImplementation(() => queryReturning(null));

    const response = await request(app).get("/playbooks/pb-someone-else");

    expect(response.status).toBe(404);
    expect(response.body.detail).toMatch(/not found/i);
  });
});
