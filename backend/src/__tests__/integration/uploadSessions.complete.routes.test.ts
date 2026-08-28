import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyFile: vi.fn(),
  deleteFile: vi.fn(),
  getSignedUploadUrl: vi.fn(),
  headFile: vi.fn(),
  rpc: vi.fn(),
  session: null as Record<string, unknown> | null,
  files: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    res.locals.userId = "11111111-1111-4111-8111-111111111111";
    res.locals.userEmail = "owner@example.com";
    next();
  },
}));

function queryFor(table: string) {
  let updatePayload: Record<string, unknown> | null = null;
  const predicates: Array<(row: Record<string, unknown>) => boolean> = [];
  const matchingFiles = () =>
    mocks.files.filter((row) => predicates.every((test) => test(row)));
  const query = {
    select: vi.fn(() => query),
    update: vi.fn((payload: Record<string, unknown>) => {
      updatePayload = payload;
      return query;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      predicates.push((row) => row[column] === value);
      return query;
    }),
    neq: vi.fn((column: string, value: unknown) => {
      predicates.push((row) => row[column] !== value);
      return query;
    }),
    in: vi.fn((column: string, values: unknown[]) => {
      predicates.push((row) => values.includes(row[column]));
      return query;
    }),
    lte: vi.fn((column: string, value: string) => {
      // Timestamps are ISO-8601, so a string comparison is a faithful stand-in
      // for the database predicate that guards verification leases.
      predicates.push((row) => String(row[column] ?? "") <= value);
      return query;
    }),
    is: vi.fn(() => query),
    order: vi.fn(() => query),
    maybeSingle: vi.fn(async () => {
      if (table === "upload_sessions") {
        if (!mocks.session) return { data: null, error: null };
        if (updatePayload) Object.assign(mocks.session, updatePayload);
        return { data: mocks.session, error: null };
      }
      if (table === "upload_processing_jobs") {
        return { data: { id: "job-1", status: "queued" }, error: null };
      }
      if (table === "upload_session_files") {
        const row = matchingFiles()[0] ?? null;
        if (row && updatePayload) Object.assign(row, updatePayload);
        return { data: row, error: null };
      }
      return { data: null, error: null };
    }),
    then: (resolve: (value: unknown) => unknown) => {
      if (table === "upload_session_files") {
        const rows = matchingFiles();
        if (updatePayload) {
          for (const file of rows) Object.assign(file, updatePayload);
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        }
        return Promise.resolve({ data: rows, error: null }).then(resolve);
      }
      if (table === "upload_sessions" && updatePayload && mocks.session) {
        Object.assign(mocks.session, updatePayload);
      }
      return Promise.resolve({ data: null, error: null }).then(resolve);
    },
  };
  return query;
}

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({
    from: (table: string) => queryFor(table),
    rpc: mocks.rpc,
  }),
}));

vi.mock("../../lib/storage", () => ({
  storageEnabled: true,
  getSignedUploadUrl: mocks.getSignedUploadUrl,
  copyFile: mocks.copyFile,
  deleteFile: mocks.deleteFile,
  headFile: mocks.headFile,
}));

import { uploadSessionsRouter } from "../../routes/uploadSessions";

const app = express();
app.use(express.json());
app.use("/upload-sessions", uploadSessionsRouter);

describe("upload session completion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session = {
      id: "22222222-2222-4222-8222-222222222222",
      user_id: "11111111-1111-4111-8111-111111111111",
      purpose: "document_create",
      destination: { scope: "standalone" },
      expected_file_count: 1,
      expected_total_bytes: 4,
      status: "pending_upload",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    mocks.files = [
      {
        id: "33333333-3333-4333-8333-333333333333",
        session_id: "22222222-2222-4222-8222-222222222222",
        resource_id: "44444444-4444-4444-8444-444444444444",
        client_id: "client-1",
        filename: "contract.pdf",
        target_folder_id: null,
        file_type: "pdf",
        content_type: "application/pdf",
        expected_size_bytes: 4,
        observed_size_bytes: null,
        staging_storage_path: "staging-key",
        sealed_storage_path: "sealed-key",
        status: "pending_upload",
        error_code: null,
        result: null,
        updated_at: "2000-01-01T00:00:00.000Z",
      },
    ];
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.deleteFile.mockResolvedValue(undefined);
    mocks.getSignedUploadUrl.mockResolvedValue(
      "https://upload.example/refreshed",
    );
    mocks.rpc.mockImplementation(async (name: string) =>
      name === "queue_upload_session_file_processing"
        ? { data: "job-1", error: null }
        : { data: "pending_upload", error: null },
    );
  });

  it("verifies, seals, and queues a file without sending its bytes to Express", async () => {
    mocks.headFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        size: 4,
        etag: "staged-etag",
        contentType: "application/pdf",
      })
      .mockResolvedValueOnce({
        size: 4,
        etag: "sealed-etag",
        contentType: "application/pdf",
      });

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(200);
    expect(mocks.copyFile).toHaveBeenCalledWith("staging-key", "sealed-key");
    expect(mocks.deleteFile).toHaveBeenCalledWith("staging-key");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "queue_upload_session_file_processing",
      {
        target_session_id: "22222222-2222-4222-8222-222222222222",
        target_user_id: "11111111-1111-4111-8111-111111111111",
        target_file_id: "33333333-3333-4333-8333-333333333333",
      },
    );
    expect(response.body.files[0]).toMatchObject({
      status: "uploaded",
      observed_size_bytes: 4,
    });
  });

  it("queues one verified file while another file is still uploading", async () => {
    mocks.session!.expected_file_count = 2;
    mocks.session!.expected_total_bytes = 8;
    mocks.files.push({
      ...mocks.files[0],
      id: "55555555-5555-4555-8555-555555555555",
      resource_id: "66666666-6666-4666-8666-666666666666",
      client_id: "client-2",
      filename: "later.pdf",
      staging_storage_path: "later-staging-key",
      sealed_storage_path: "later-sealed-key",
    });
    mocks.headFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        size: 4,
        etag: "staged-etag",
        contentType: "application/pdf",
      })
      .mockResolvedValueOnce({
        size: 4,
        etag: "sealed-etag",
        contentType: "application/pdf",
      });

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(200);
    expect(mocks.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_id: "client-1", status: "uploaded" }),
        expect.objectContaining({
          client_id: "client-2",
          status: "pending_upload",
        }),
      ]),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "queue_upload_session_file_processing",
      {
        target_session_id: "22222222-2222-4222-8222-222222222222",
        target_user_id: "11111111-1111-4111-8111-111111111111",
        target_file_id: "33333333-3333-4333-8333-333333333333",
      },
    );
  });

  it("does not expose session-wide completion", async () => {
    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/complete",
    );

    expect(response.status).toBe(404);
    expect(mocks.headFile).not.toHaveBeenCalled();
    expect(mocks.copyFile).not.toHaveBeenCalled();
  });

  it("cancels a pending session and deletes both temporary object keys", async () => {
    const response = await request(app).delete(
      "/upload-sessions/22222222-2222-4222-8222-222222222222",
    );

    expect(response.status).toBe(204);
    expect(mocks.deleteFile).toHaveBeenCalledWith("staging-key");
    expect(mocks.deleteFile).toHaveBeenCalledWith("sealed-key");
    expect(mocks.session).toMatchObject({
      status: "cancelled",
      cleaned_at: expect.any(String),
    });
  });

  it("refreshes PUT URLs for files that have not been verified", async () => {
    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/urls",
    );

    expect(response.status).toBe(200);
    expect(response.body.files[0].upload).toMatchObject({
      method: "PUT",
      url: "https://upload.example/refreshed",
    });
    expect(mocks.getSignedUploadUrl).toHaveBeenCalledWith(
      "staging-key",
      "application/pdf",
      4,
      expect.any(Number),
    );
  });

  it("does not reclaim a verifying file whose lease is still fresh", async () => {
    mocks.files[0]!.status = "verifying";
    mocks.files[0]!.updated_at = new Date().toISOString();

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/urls",
    );

    expect(response.status).toBe(200);
    expect(mocks.files[0]).toMatchObject({ status: "verifying" });
  });

  it("reclaims a verifying file whose lease has expired", async () => {
    mocks.files[0]!.status = "verifying";
    mocks.files[0]!.updated_at = "2000-01-01T00:00:00.000Z";

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/urls",
    );

    expect(response.status).toBe(200);
    expect(mocks.files[0]).toMatchObject({ status: "pending_upload" });
  });

  it("does not publish a seal result after its verification claim is stolen", async () => {
    mocks.headFile.mockImplementationOnce(async () => {
      mocks.files[0]!.status = "pending_upload";
      return { size: 4, etag: "sealed-etag", contentType: "application/pdf" };
    });

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("upload_incomplete");
    expect(mocks.files[0]).toMatchObject({ status: "pending_upload" });
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "queue_upload_session_file_processing",
      expect.anything(),
    );
  });

  it("extends the session deadline after a file is sealed and queued", async () => {
    mocks.headFile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        size: 4,
        etag: "staged-etag",
        contentType: "application/pdf",
      })
      .mockResolvedValueOnce({
        size: 4,
        etag: "sealed-etag",
        contentType: "application/pdf",
      });

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("extend_upload_session_expiry", {
      target_session_id: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("still reports success when the deadline cannot be extended", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "extend_upload_session_expiry") {
        return { data: null, error: { message: "rpc unavailable" } };
      }
      return name === "queue_upload_session_file_processing"
        ? { data: "job-1", error: null }
        : { data: "pending_upload", error: null };
    });
    mocks.files[0]!.status = "uploaded";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("does not extend the deadline when the client reports a failed transfer", async () => {
    const response = await request(app)
      .post(
        "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
      )
      .send({ failed: true });

    expect(response.status).toBe(200);
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "extend_upload_session_expiry",
      expect.anything(),
    );
  });

  it("records and removes an object larger than its reservation", async () => {
    mocks.headFile.mockResolvedValueOnce(null).mockResolvedValueOnce({
      size: 5,
      etag: "oversized-etag",
      contentType: "application/pdf",
    });

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(200);
    expect(response.body.files[0]).toMatchObject({
      status: "error",
      error_code: "size_mismatch",
    });
    expect(mocks.deleteFile).toHaveBeenCalledWith("staging-key");
    expect(mocks.rpc).not.toHaveBeenCalledWith(
      "queue_upload_session_file_processing",
      expect.anything(),
    );
  });

  it("keeps completed files when the client reports another transfer failed", async () => {
    mocks.session!.expected_file_count = 2;
    mocks.session!.expected_total_bytes = 8;
    mocks.files.push({
      ...mocks.files[0],
      id: "55555555-5555-4555-8555-555555555555",
      resource_id: "66666666-6666-4666-8666-666666666666",
      client_id: "client-2",
      filename: "failed.pdf",
      staging_storage_path: "failed-staging-key",
      sealed_storage_path: "failed-sealed-key",
    });
    mocks.files[0]!.status = "completed";

    const response = await request(app)
      .post(
        "/upload-sessions/22222222-2222-4222-8222-222222222222/files/55555555-5555-4555-8555-555555555555/complete",
      )
      .send({ failed: true });

    expect(response.status).toBe(200);
    expect(mocks.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ client_id: "client-1", status: "completed" }),
        expect.objectContaining({
          client_id: "client-2",
          status: "error",
          error_code: "direct_upload_failed",
        }),
      ]),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "refresh_upload_session_status",
      expect.any(Object),
    );
  });

  it("keeps an early processing file when a later transfer fails", async () => {
    mocks.session!.expected_file_count = 2;
    mocks.session!.expected_total_bytes = 8;
    mocks.files[0]!.status = "processing";
    mocks.files.push({
      ...mocks.files[0],
      id: "55555555-5555-4555-8555-555555555555",
      resource_id: "66666666-6666-4666-8666-666666666666",
      client_id: "client-2",
      filename: "failed.pdf",
      staging_storage_path: "failed-staging-key",
      sealed_storage_path: "failed-sealed-key",
      status: "pending_upload",
    });

    const response = await request(app)
      .post(
        "/upload-sessions/22222222-2222-4222-8222-222222222222/files/55555555-5555-4555-8555-555555555555/complete",
      )
      .send({ failed: true });

    expect(response.status).toBe(200);
    expect(mocks.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          client_id: "client-1",
          status: "processing",
        }),
        expect.objectContaining({ client_id: "client-2", status: "error" }),
      ]),
    );
    expect(mocks.rpc).toHaveBeenCalledWith(
      "refresh_upload_session_status",
      expect.any(Object),
    );
    expect(mocks.session!.status).not.toBe("error");
  });

  it("records an uploaded object with the wrong content type", async () => {
    mocks.headFile.mockResolvedValueOnce(null).mockResolvedValueOnce({
      size: 4,
      etag: "staged-etag",
      contentType: "text/plain",
    });

    const response = await request(app).post(
      "/upload-sessions/22222222-2222-4222-8222-222222222222/files/33333333-3333-4333-8333-333333333333/complete",
    );

    expect(response.status).toBe(200);
    expect(response.body.files[0]).toMatchObject({
      status: "error",
      error_code: "content_type_mismatch",
    });
    expect(mocks.deleteFile).toHaveBeenCalledWith("staging-key");
  });

  it("allows a stale verifying session to be cancelled", async () => {
    mocks.session!.status = "verifying";
    mocks.session!.updated_at = "2000-01-01T00:00:00.000Z";

    const response = await request(app).delete(
      "/upload-sessions/22222222-2222-4222-8222-222222222222",
    );

    expect(response.status).toBe(204);
    expect(mocks.session).toMatchObject({ status: "cancelled" });
  });
});
