import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkProjectAccess: vi.fn(),
  ensureMemoryFile: vi.fn(),
  getMemoryCurrent: vi.fn(),
  wipeMemoryFile: vi.fn(),
  writeMemoryFile: vi.fn(),
  enableMemoryFile: vi.fn(),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (
    _req: unknown,
    res: { locals: Record<string, unknown> },
    next: () => void,
  ) => {
    res.locals.userId = "00000000-0000-4000-8000-000000000001";
    res.locals.userEmail = "user@example.com";
    next();
  },
}));

vi.mock("../../lib/supabase", () => ({
  createServerSupabase: () => ({ marker: "db" }),
}));

vi.mock("../../lib/access", () => ({
  checkProjectAccess: (...args: unknown[]) => mocks.checkProjectAccess(...args),
}));

vi.mock("../../lib/memory/files", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../lib/memory/files")>();
  return {
    ...original,
    ensureMemoryFile: (...args: unknown[]) => mocks.ensureMemoryFile(...args),
    getMemoryCurrent: (...args: unknown[]) => mocks.getMemoryCurrent(...args),
    wipeMemoryFile: (...args: unknown[]) => mocks.wipeMemoryFile(...args),
    writeMemoryFile: (...args: unknown[]) => mocks.writeMemoryFile(...args),
    enableMemoryFile: (...args: unknown[]) => mocks.enableMemoryFile(...args),
  };
});

import { projectMemoryRouter, userMemoryRouter } from "../../modules/memory/memory.routes";
import { MemoryRevisionConflictError } from "../../lib/memory/files";

const file = {
  id: "00000000-0000-4000-8000-000000000010",
  scope: "user" as const,
  user_id: "00000000-0000-4000-8000-000000000001",
  project_id: null,
  enabled: true,
  epoch: 0,
  revision: 2,
  learning_cutoff_at: "2026-09-05T00:00:00.000Z",
  current_version_id: "00000000-0000-4000-8000-000000000011",
  status: "idle" as const,
  last_error_code: null,
  last_source: null,
  updated_by: null,
  created_at: "2026-09-05T00:00:00.000Z",
  updated_at: "2026-09-05T00:00:00.000Z",
};

const current = {
  enabled: true,
  content: "# Memory",
  revision: 2,
  hash: "a".repeat(64),
  updated_at: "2026-09-05T00:00:00.000Z",
  updated_by: "00000000-0000-4000-8000-000000000001",
  status: "idle" as const,
};

function testApp() {
  const app = express();
  app.use(express.json());
  app.use("/user/memory", userMemoryRouter);
  app.use("/projects/:projectId/memory", projectMemoryRouter);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureMemoryFile.mockResolvedValue(file);
  mocks.getMemoryCurrent.mockResolvedValue({ current, file });
  mocks.writeMemoryFile.mockResolvedValue({ current, applied: true });
  mocks.wipeMemoryFile.mockResolvedValue({
    ...current,
    content: "",
    revision: 0,
    hash: null,
    updated_at: null,
    updated_by: null,
  });
  mocks.enableMemoryFile.mockResolvedValue(current);
  mocks.checkProjectAccess.mockResolvedValue({
    ok: true,
    projectRole: "owner",
  });
});

describe("scoped memory routes", () => {
  it("returns the locked snake_case current representation", async () => {
    const response = await request(testApp()).get("/user/memory").expect(200);
    expect(response.body).toEqual(current);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
      expect.anything(),
      "user",
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("uses expected_revision CAS and returns the current value on conflict", async () => {
    mocks.writeMemoryFile.mockRejectedValueOnce(
      new MemoryRevisionConflictError("changed"),
    );
    const response = await request(testApp())
      .put("/user/memory")
      .send({ content: "next", expected_revision: 2 })
      .expect(409);
    expect(response.body).toMatchObject({
      code: "memory_revision_conflict",
      current,
    });
  });

  it("destructively disables user memory but user DELETE preserves the enable state", async () => {
    await request(testApp())
      .patch("/user/memory/settings")
      .send({ enabled: false })
      .expect(200);
    expect(mocks.wipeMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );

    await request(testApp()).delete("/user/memory").expect(200);
    expect(mocks.wipeMemoryFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: null }),
    );
  });

  it("allows project viewers to read but only editors to write", async () => {
    mocks.checkProjectAccess.mockResolvedValue({
      ok: true,
      projectRole: "viewer",
    });
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";

    await request(testApp()).get(base).expect(200);
    await request(testApp())
      .put(base)
      .send({ content: "next", expected_revision: 2 })
      .expect(403);
    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(403);
    expect(mocks.writeMemoryFile).not.toHaveBeenCalled();
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("opens a project's first memory file enabled", async () => {
    mocks.checkProjectAccess.mockResolvedValue({
      ok: true,
      projectRole: "viewer",
    });
    const projectId = "00000000-0000-4000-8000-000000000020";

    await request(testApp()).get(`/projects/${projectId}/memory`).expect(200);

    // Project memory is on by default: a project whose row predates the
    // memory tables must not be created opted out by the first read.
    expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
      { marker: "db" },
      "project",
      projectId,
    );
    expect(mocks.getMemoryCurrent).toHaveBeenCalledWith(
      { marker: "db" },
      "project",
      projectId,
    );
  });

  it("does not expose a standalone project-memory wipe route", async () => {
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";

    await request(testApp()).delete(base).expect(404);

    expect(mocks.checkProjectAccess).not.toHaveBeenCalled();
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("returns 404 for every project operation when access is absent", async () => {
    mocks.checkProjectAccess.mockResolvedValue({ ok: false, status: 404 });
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";

    await request(testApp()).get(base).expect(404);
    await request(testApp())
      .put(base)
      .send({ content: "next", expected_revision: 2 })
      .expect(404);
    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(404);
    expect(mocks.writeMemoryFile).not.toHaveBeenCalled();
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("lets editors edit but reserves destructive controls for owners", async () => {
    mocks.checkProjectAccess.mockResolvedValue({
      ok: true,
      projectRole: "editor",
    });
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";

    await request(testApp())
      .put(base)
      .send({ content: "next", expected_revision: 2 })
      .expect(200);
    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(403);
    expect(mocks.writeMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({
        file,
        content: "next",
        expectedRevision: 2,
        source: "manual",
      }),
    );
    expect(mocks.wipeMemoryFile).not.toHaveBeenCalled();
  });

  it("allows project owners to disable shared memory", async () => {
    const base = "/projects/00000000-0000-4000-8000-000000000020/memory";

    await request(testApp())
      .patch(`${base}/settings`)
      .send({ enabled: false })
      .expect(200);
    expect(mocks.wipeMemoryFile).toHaveBeenCalledOnce();
    expect(mocks.wipeMemoryFile).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, source: "settings" }),
    );
  });
});
