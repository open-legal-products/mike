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

vi.mock("../../modules/playbooks/playbooks.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../modules/playbooks/playbooks.service")>();
  return { ...actual, importPlaybookFromDocx };
});

import { playbooksRouter } from "../../modules/playbooks/playbooks.routes";
import { PlaybookRequestError } from "../../modules/playbooks/playbooks.service";

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

function playbookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "pb-1",
    user_id: "u1",
    name: "Commercial Playbook",
    description: "",
    status: "draft",
    draft_json: {
      name: "Commercial Playbook",
      description: "",
      globalGuidance: "",
      representedParty: "Customer",
      documentTypes: [],
      jurisdictions: [],
      topics: [
        {
          id: "liability",
          name: "Liability",
          rules: [
            {
              id: "liability-cap",
              name: "Liability cap",
              concept: "Determine whether liability is capped.",
              scope: "clause",
              required: true,
              guidance: "",
              standard: null,
              fallbacks: [],
              unacceptable: [],
              sourceRefs: [],
            },
          ],
        },
      ],
    },
    published_version_id: null,
    source_filename: null,
    source_storage_key: "playbooks/u1/source.docx",
    import_model: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// A query whose terminal await resolves with an error, the way supabase-js
// reports a refused statement instead of throwing.
function queryFailingOn(failing: string, error: unknown) {
  const query: Record<string, unknown> = {};
  let failed = false;
  for (const method of ["select", "insert", "update", "delete", "eq", "order", "in"]) {
    query[method] = vi.fn(() => {
      if (method === failing) failed = true;
      return query;
    });
  }
  const settle = async () => ({
    data: failed ? null : playbookRow(),
    error: failed ? error : null,
  });
  query.single = vi.fn(settle);
  query.maybeSingle = vi.fn(settle);
  query.then = (
    resolve: (value: unknown) => unknown,
    reject?: (error: unknown) => unknown,
  ) => settle().then(resolve, reject);
  return query;
}

describe("creating a playbook without a Word file", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a blank playbook the editor can open", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app).post("/playbooks").send({});

    expect(response.status).toBe(201);
    expect(importPlaybookFromDocx).not.toHaveBeenCalled();
  });

  it("accepts a name for the new playbook", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app)
      .post("/playbooks")
      .send({ name: "Vendor MSA playbook" });

    expect(response.status).toBe(201);
  });

  it("refuses a name that is too long", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app)
      .post("/playbooks")
      .send({ name: "x".repeat(201) });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/too long/i);
  });
});

describe("replacing a playbook from a Word file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headFile.mockResolvedValue({ size: 2048, etag: null, contentType: null });
    downloadFile.mockResolvedValue(new TextEncoder().encode("docx").buffer);
    deleteFile.mockResolvedValue(undefined);
    importPlaybookFromDocx.mockResolvedValue({ id: "pb-1", name: "Replaced" });
  });

  it("passes the target playbook to the import", async () => {
    const response = await request(app).post("/playbooks/import").send({
      storageKey: "playbooks/u1/imports/new.docx",
      filename: "new.docx",
      model: "claude-opus-5",
      playbookId: "pb-1",
    });

    expect(response.status).toBe(200);
    expect(importPlaybookFromDocx).toHaveBeenCalledWith(
      expect.objectContaining({ playbookId: "pb-1" }),
    );
  });

  it("creates a playbook when no target is given", async () => {
    const response = await request(app).post("/playbooks/import").send({
      storageKey: "playbooks/u1/imports/new.docx",
      filename: "new.docx",
      model: "claude-opus-5",
    });

    expect(response.status).toBe(201);
    expect(importPlaybookFromDocx).toHaveBeenCalledWith(
      expect.objectContaining({ playbookId: undefined }),
    );
  });
});

describe("playbook input validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["an empty playbook name", { name: "", topics: [{ id: "t", name: "T", rules: [] }] }],
    ["a playbook with no topics", { name: "Commercial Playbook", topics: [] }],
    ["a body that is not a playbook", { unrelated: true }],
  ])("answers 400, not 500, for %s", async (_label, draft) => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app).put("/playbooks/pb-1").send(draft);

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/could not be saved/i);
    expect(response.body.code).not.toBe("internal_error");
  });

  it("answers 400, not 500, for a model id it does not recognise", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app)
      .post("/playbooks/pb-1/review")
      .send({ documentText: "A contract.", model: "bogus/not-a-model" });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/not a model/i);
  });
});

describe("playbook deletion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports a refused delete instead of answering 204", async () => {
    from.mockImplementation(() =>
      queryFailingOn("delete", { code: "42501", message: "permission denied" }),
    );

    const response = await request(app).delete("/playbooks/pb-1");

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/permission denied/);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("answers 204 and clears the stored source when every delete succeeds", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));
    deleteFile.mockResolvedValue(undefined);

    const response = await request(app).delete("/playbooks/pb-1");

    expect(response.status).toBe(204);
    expect(deleteFile).toHaveBeenCalledWith("playbooks/u1/source.docx");
  });
});

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
