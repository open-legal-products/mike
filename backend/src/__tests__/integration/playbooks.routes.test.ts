import { Readable } from "node:stream";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  from,
  createFileReadStream,
  deleteFile,
  downloadFile,
  getSignedUploadUrl,
  headFile,
  importPlaybookFromDocx,
} = vi.hoisted(() => ({
  from: vi.fn(),
  createFileReadStream: vi.fn(),
  deleteFile: vi.fn(),
  downloadFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  headFile: vi.fn(),
  importPlaybookFromDocx: vi.fn(),
}));

vi.mock("../../lib/supabase", () => ({
  // Creator profiles are looked up per listing; these tests have none.
  createServerSupabase: () => ({
    // Creator profiles and sharing grants are looked up per playbook; these
    // tests have none. The module tests cover sharing.
    from: (table: string) =>
      table === "user_profiles" ||
      table === "playbook_shares" ||
      table === "playbook_org_access_overrides"
        ? queryReturning([])
        : from(table),
  }),
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
    createFileReadStream,
    deleteFile,
    downloadFile,
    getSignedUploadUrl,
    headFile,
  };
});

vi.mock("../../modules/playbooks/playbooks.service", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../modules/playbooks/playbooks.service")
    >();
  return { ...actual, importPlaybookFromDocx };
});

import { playbooksRouter } from "../../modules/playbooks/playbooks.routes";
import { PlaybookRequestError } from "../../modules/playbooks/playbooks.service";

// Keys shaped exactly as the upload-URL routes mint them.
const STAGED_IMPORT_KEY = "playbooks/u1/imports/11111111-2222-4333-8444-555555555555.docx";
const STAGED_SOURCE_KEY = "playbooks/u1/source-uploads/11111111-2222-4333-8444-555555555555.pdf";

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
    "is",
    "contains",
    "limit",
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
    content_json: {
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
    source_filename: null,
    source_storage_key: "playbooks/u1/source.docx",
    import_model: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function sourceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "s1",
    filename: "Data policy.pdf",
    file_type: "pdf",
    size_bytes: 1200,
    storage_key: "playbooks/u1/pb-1/sources/s1.pdf",
    text_length: 52,
    created_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

// A query whose terminal await resolves with an error, the way supabase-js
// reports a refused statement instead of throwing.
function queryFailingOn(failing: string, error: unknown) {
  const query: Record<string, unknown> = {};
  let failed = false;
  for (const method of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "order",
    "in",
  ]) {
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

  it("accepts a name and details for the new playbook", async () => {
    const query = queryReturning(playbookRow());
    from.mockImplementation(() => query);

    const response = await request(app).post("/playbooks").send({
      name: "Vendor MSA playbook",
      representedParty: "Customer",
      documentTypes: ["MSA"],
      jurisdictions: ["New York"],
    });

    expect(response.status).toBe(201);
    expect(query.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Vendor MSA playbook",
        content_json: expect.objectContaining({
          representedParty: "Customer",
          documentTypes: ["MSA"],
          jurisdictions: ["New York"],
        }),
      }),
    );
  });

  it("refuses invalid details for the new playbook", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app)
      .post("/playbooks")
      .send({ name: "Vendor MSA playbook", documentTypes: "MSA" });

    expect(response.status).toBe(400);
    expect(response.body.detail).toMatch(/invalid field/i);
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
      storageKey: STAGED_IMPORT_KEY,
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
      storageKey: STAGED_IMPORT_KEY,
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
    [
      "an empty playbook name",
      { name: "", topics: [{ id: "t", name: "T", rules: [] }] },
      200,
    ],
    [
      "a playbook with no topics",
      { name: "Commercial Playbook", topics: [] },
      200,
    ],
    ["a body that is not a playbook", { unrelated: true }, 400],
  ])("handles autosaving %s", async (_label, body, status) => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app).put("/playbooks/pb-1").send(body);

    expect(response.status).toBe(status);
    if (status === 400) expect(response.body.detail).toMatch(/invalid field/i);
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

describe("runs across playbooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("answers /playbooks/runs itself rather than as a playbook id", async () => {
    from.mockImplementation(() => queryReturning([]));

    const response = await request(app).get("/playbooks/runs?workspace=personal");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });
});

describe("playbook deletion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports a refused delete instead of answering 204", async () => {
    const playbook = queryFailingOn("delete", { code: "42501", message: "permission denied" });
    from.mockImplementation((table: string) =>
      table === "playbook_sources" ? queryReturning([]) : playbook,
    );

    const response = await request(app).delete("/playbooks/pb-1");

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toMatch(/permission denied/);
    expect(deleteFile).not.toHaveBeenCalled();
    expect(playbook.delete).toHaveBeenCalledOnce();
    // The database cascades runs only when the parent deletion succeeds.
    expect(from).not.toHaveBeenCalledWith("playbook_runs");
  });

  it("answers 204 and clears the stored source when every delete succeeds", async () => {
    from.mockImplementation((table: string) =>
      queryReturning(
        table === "playbook_sources"
          ? [sourceRow({ storage_key: "playbooks/u1/pb-1/sources/s1.pdf" })]
          : playbookRow(),
      ),
    );
    deleteFile.mockResolvedValue(undefined);

    const response = await request(app).delete("/playbooks/pb-1");

    expect(response.status).toBe(204);
    expect(deleteFile).toHaveBeenCalledWith("playbooks/u1/source.docx");
    expect(deleteFile).toHaveBeenCalledWith(
      "playbooks/u1/pb-1/sources/s1.pdf",
    );
  });
});

describe("playbook source document", () => {
  beforeEach(() => vi.clearAllMocks());

  it("streams the stored Word file inline for a viewer", async () => {
    from.mockImplementation(() =>
      queryReturning(playbookRow({ source_filename: "Liability guide.docx" })),
    );
    headFile.mockResolvedValue({ size: 4, etag: null, contentType: null });
    createFileReadStream.mockReturnValue(Readable.from([Buffer.from("PK\x03\x04")]));

    const response = await request(app)
      .get("/playbooks/pb-1/source")
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/wordprocessingml/);
    expect(response.headers["content-disposition"]).toMatch(
      /^inline;.*Liability guide\.docx/,
    );
    expect(Buffer.from(response.body).toString("latin1")).toBe("PK\x03\x04");
    expect(createFileReadStream).toHaveBeenCalledWith(
      "playbooks/u1/source.docx",
    );
  });

  it("answers 404 for a playbook written in the app", async () => {
    from.mockImplementation(() =>
      queryReturning(playbookRow({ source_storage_key: null })),
    );

    const response = await request(app).get("/playbooks/pb-1/source");

    expect(response.status).toBe(404);
    expect(response.body.detail).toMatch(/no source document/i);
    expect(headFile).not.toHaveBeenCalled();
  });

  it("answers 404 when the stored file is gone", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));
    headFile.mockResolvedValue(null);

    const response = await request(app).get("/playbooks/pb-1/source");

    expect(response.status).toBe(404);
    expect(createFileReadStream).not.toHaveBeenCalled();
  });

  it("does not reveal the source of a playbook the caller cannot view", async () => {
    from.mockImplementation(() =>
      queryReturning(playbookRow({ user_id: "someone-else" })),
    );

    const response = await request(app).get("/playbooks/pb-1/source");

    expect(response.status).toBe(404);
    expect(response.body.detail).toMatch(/not found/i);
    expect(headFile).not.toHaveBeenCalled();
    expect(createFileReadStream).not.toHaveBeenCalled();
  });
});

describe("playbook supplementary documents over HTTP", () => {
  beforeEach(() => vi.clearAllMocks());

  it("signs a .pdf upload under the caller's own prefix and refuses other types", async () => {
    getSignedUploadUrl.mockResolvedValue("https://storage.example/put");

    const refused = await request(app)
      .post("/playbooks/pb-1/sources/upload-url")
      .send({ filename: "notes.txt", sizeBytes: 10 });
    expect(refused.status).toBe(400);

    const response = await request(app)
      .post("/playbooks/pb-1/sources/upload-url")
      .send({ filename: "Policy.pdf", sizeBytes: 2048 });
    expect(response.status).toBe(201);
    expect(response.body.storageKey).toMatch(
      /^playbooks\/u1\/source-uploads\/[0-9a-f-]+\.pdf$/,
    );
    expect(response.body.contentType).toBe("application/pdf");
  });

  it("clears the caller's staged upload even when adding fails", async () => {
    from.mockImplementation(() => queryReturning(null));
    deleteFile.mockResolvedValue(undefined);

    const response = await request(app)
      .post("/playbooks/pb-1/sources")
      .send({ storageKey: STAGED_SOURCE_KEY, filename: "a.pdf" });

    expect(response.status).toBe(404);
    expect(deleteFile).toHaveBeenCalledWith(STAGED_SOURCE_KEY);
  });

  it("never deletes an object outside the caller's staging prefix", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app)
      .post("/playbooks/pb-1/sources")
      .send({ storageKey: "playbooks/u2/source-uploads/11111111-2222-4333-8444-555555555555.pdf", filename: "a.pdf" });

    expect(response.status).toBe(400);
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("refuses a staged key that traverses out of the caller's prefix", async () => {
    from.mockImplementation(() => queryReturning(playbookRow()));

    const response = await request(app).post("/playbooks/pb-1/sources").send({
      storageKey:
        "playbooks/u1/source-uploads/../../../documents/u2/d1/source.pdf",
      filename: "a.pdf",
    });

    expect(response.status).toBe(400);
    expect(headFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("streams a supplementary document with its own type", async () => {
    from.mockImplementation((table: string) =>
      queryReturning(table === "playbook_sources" ? [sourceRow()] : playbookRow()),
    );
    headFile.mockResolvedValue({ size: 4, etag: null, contentType: null });
    createFileReadStream.mockReturnValue(Readable.from([Buffer.from("%PDF")]));

    const response = await request(app).get("/playbooks/pb-1/sources/s1/file");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toMatch(/Data policy\.pdf/);
    expect(createFileReadStream).toHaveBeenCalledWith(
      "playbooks/u1/pb-1/sources/s1.pdf",
    );

    const missing = await request(app).get("/playbooks/pb-1/sources/nope/file");
    expect(missing.status).toBe(404);
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
      .send({ storageKey: "playbooks/u2/imports/11111111-2222-4333-8444-555555555555.docx", model: "gpt-5.4" });

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

  it.each([
    "playbooks/u1/imports/../../../documents/u2/d1/source.docx",
    `playbooks/u1/imports/${"1".repeat(8)}/../../u2/imports/x.docx`,
    "playbooks/u1/imports/abc.docx",
    "playbooks/u1/imports/11111111-2222-4333-8444-555555555555.pdf",
  ])("refuses a key the upload route never mints: %s", async (storageKey) => {
    const response = await request(app)
      .post("/playbooks/import")
      .send({ storageKey, model: "gpt-5.4" });

    expect(response.status).toBe(400);
    expect(headFile).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("compiles a staged upload and clears the staged object", async () => {
    importPlaybookFromDocx.mockResolvedValue({ id: "pb1", name: "Imported" });

    const response = await request(app).post("/playbooks/import").send({
      storageKey: STAGED_IMPORT_KEY,
      filename: "playbook.docx",
      model: "gpt-5.4",
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: "pb1" });
    expect(importPlaybookFromDocx).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", filename: "playbook.docx" }),
    );
    expect(deleteFile).toHaveBeenCalledWith(STAGED_IMPORT_KEY);
  });

  it("clears the staged object even when compilation fails", async () => {
    importPlaybookFromDocx.mockRejectedValue(
      new PlaybookRequestError("Select a model."),
    );

    const response = await request(app).post("/playbooks/import").send({
      storageKey: STAGED_IMPORT_KEY,
      model: "",
    });

    expect(response.status).toBe(400);
    expect(response.body.detail).toBe("Select a model.");
    expect(deleteFile).toHaveBeenCalledWith(STAGED_IMPORT_KEY);
  });

  it("reports a staged object that expired before the import ran", async () => {
    headFile.mockResolvedValue(null);

    const response = await request(app)
      .post("/playbooks/import")
      .send({ storageKey: STAGED_IMPORT_KEY, model: "gpt-5.4" });

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
