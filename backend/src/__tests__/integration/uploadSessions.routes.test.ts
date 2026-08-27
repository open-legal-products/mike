import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getSignedUploadUrl: vi.fn(),
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

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ rpc: mocks.rpc }),
}));

vi.mock("../../lib/storage", () => ({
  storageEnabled: true,
  getSignedUploadUrl: mocks.getSignedUploadUrl,
  copyFile: vi.fn(),
  deleteFile: vi.fn(),
  headFile: vi.fn(),
}));

import { uploadSessionsRouter } from "../../routes/uploadSessions";

const app = express();
app.use(express.json());
app.use("/upload-sessions", uploadSessionsRouter);

function manifest(fileCount = 1) {
  return {
    purpose: "document_create",
    destination: { scope: "standalone" },
    files: Array.from({ length: fileCount }, (_, index) => ({
      client_id: `client-${index}`,
      filename: `contract-${index}.pdf`,
      size_bytes: 1234,
    })),
  };
}

describe("upload session routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rpc.mockResolvedValue({ error: null });
    mocks.getSignedUploadUrl.mockResolvedValue("https://upload.example/signed");
  });

  it("creates one atomic session reservation and returns direct PUT URLs", async () => {
    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest(2));

    expect(response.status).toBe(201);
    expect(response.body.session).toMatchObject({
      expected_file_count: 2,
      expected_total_bytes: 2468,
      status: "pending_upload",
    });
    expect(response.body.files).toHaveLength(2);
    expect(response.body.files[0].upload).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
    });
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.rpc).toHaveBeenCalledWith(
      "create_upload_session",
      expect.objectContaining({ target_hourly_session_limit: 50 }),
    );
    expect(mocks.getSignedUploadUrl).toHaveBeenCalledTimes(2);
  });

  it("rejects more than 50 files without touching the database or storage", async () => {
    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest(51));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("rejects unsupported file extensions before reserving a session", async () => {
    const requestBody = manifest();
    requestBody.files[0].filename = "notes.txt";

    const response = await request(app)
      .post("/upload-sessions")
      .send(requestBody);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_upload_session",
      detail: expect.stringContaining("Unsupported file type: txt"),
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("returns an explicit 413 when a declared file exceeds 100 MB", async () => {
    const requestBody = manifest();
    requestBody.files[0].size_bytes = 100 * 1024 * 1024 + 1;

    const response = await request(app)
      .post("/upload-sessions")
      .send(requestBody);

    expect(response.status).toBe(413);
    expect(response.body.code).toBe("upload_file_too_large");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("blocks a concurrent upload that targets the same mutable item", async () => {
    mocks.rpc.mockResolvedValue({ error: { message: "upload_target_busy" } });

    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest());

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("upload_target_busy");
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("applies the upload rate limit to sessions instead of individual files", async () => {
    mocks.rpc.mockResolvedValue({
      error: { message: "upload_session_rate_limit_exceeded" },
    });

    const response = await request(app)
      .post("/upload-sessions")
      .send(manifest(50));

    expect(response.status).toBe(429);
    expect(response.body.code).toBe("upload_session_rate_limit_exceeded");
    expect(mocks.rpc).toHaveBeenCalledOnce();
    expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
  });

  it("returns 404 for an invalid session id before querying the database", async () => {
    const response = await request(app).get("/upload-sessions/not-a-uuid");

    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
