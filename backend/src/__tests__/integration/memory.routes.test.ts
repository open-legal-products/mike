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
  resolveWorkspaceFilter: vi.fn(),
}));

// Which organizations the caller belongs to is the database's to say; the
// route's part is to ask, and to act on the answer.
vi.mock("../../lib/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/workspace")>()),
  resolveWorkspaceFilter: (...args: unknown[]) =>
    mocks.resolveWorkspaceFilter(...args),
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
  // No ?workspace= on the request: Personal.
  mocks.resolveWorkspaceFilter.mockResolvedValue({ ok: true, workspace: null });
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
    // With no workspace named, the caller's Personal memory.
    expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
      expect.anything(),
      "user",
      "00000000-0000-4000-8000-000000000001",
      null,
    );
  });

  // A person has one memory per workspace, each private to them.
  describe("a person's memory for one workspace", () => {
    const USER = "00000000-0000-4000-8000-000000000001";
    const ORG = "7b1d9d0e-3c5a-4f6e-9a51-0c2f7d3e8a11";

    it("reads the memory for the organization named, not Personal", async () => {
      mocks.resolveWorkspaceFilter.mockResolvedValue({
        ok: true,
        workspace: ORG,
      });
      await request(testApp()).get(`/user/memory?workspace=${ORG}`).expect(200);

      expect(mocks.resolveWorkspaceFilter).toHaveBeenCalledWith(
        { marker: "db" },
        USER,
        ORG,
      );
      expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
        { marker: "db" },
        "user",
        USER,
        ORG,
      );
      expect(mocks.getMemoryCurrent).toHaveBeenCalledWith(
        { marker: "db" },
        "user",
        USER,
        ORG,
      );
    });

    it("treats ?workspace=personal as Personal", async () => {
      mocks.resolveWorkspaceFilter.mockResolvedValue({
        ok: true,
        workspace: "personal",
      });
      await request(testApp()).get("/user/memory?workspace=personal").expect(200);
      expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
        { marker: "db" },
        "user",
        USER,
        null,
      );
    });

    it.each([
      ["put", "/user/memory", { content: "next", expected_revision: 3 }],
      ["patch", "/user/memory/settings", { enabled: false }],
      ["delete", "/user/memory", undefined],
    ] as const)(
      "%s %s changes that organization's memory and no other",
      async (method, path, body) => {
        mocks.resolveWorkspaceFilter.mockResolvedValue({
          ok: true,
          workspace: ORG,
        });
        const pending = request(testApp())[method](`${path}?workspace=${ORG}`);
        await (body ? pending.send(body) : pending).expect(200);
        expect(mocks.ensureMemoryFile).toHaveBeenCalledTimes(1);
        expect(mocks.ensureMemoryFile).toHaveBeenCalledWith(
          { marker: "db" },
          "user",
          USER,
          ORG,
        );
      },
    );

    it("404s an organization the caller is not in, and opens no memory", async () => {
      mocks.resolveWorkspaceFilter.mockResolvedValue({
        ok: false,
        kind: "not_found",
      });
      const response = await request(testApp())
        .get(`/user/memory?workspace=${ORG}`)
        .expect(404);
      expect(response.body).toEqual({
        detail: "Workspace not found",
        code: "workspace_not_found",
      });
      expect(mocks.ensureMemoryFile).not.toHaveBeenCalled();
    });

    it("400s a workspace that is neither 'personal' nor an organization id", async () => {
      mocks.resolveWorkspaceFilter.mockResolvedValue({
        ok: false,
        kind: "validation",
      });
      await request(testApp())
        .put("/user/memory?workspace=everything")
        .send({ content: "next", expected_revision: 3 })
        .expect(400);
      expect(mocks.writeMemoryFile).not.toHaveBeenCalled();
    });
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
