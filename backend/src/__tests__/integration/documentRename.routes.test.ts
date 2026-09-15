import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Db } from "../../lib/supabase";
import { scriptedDb } from "../helpers/scriptedDb";
const state = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  access: vi.fn(),
}));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => state.db }));
vi.mock("../../middleware/auth", async () => {
  const { authMock } = await import("../helpers/authMock.js");
  return authMock();
});
vi.mock("../../lib/access", async (original) => ({
  ...(await original<typeof import("../../lib/access")>()),
  checkProjectAccess: state.access,
}));
import { app } from "../../app";

beforeEach(() => {
  vi.clearAllMocks();
  state.access.mockResolvedValue({ ok: true, projectRole: "editor" });
});
const doc = {
  id: "doc",
  current_version_id: "v2",
  library_folder_id: "folder",
};
const paths = [
  "/projects/p/documents/doc",
  "/library/files/documents/doc",
  "/library/templates/documents/doc",
];

describe.each(paths)("rename response compatibility: %s", (path) => {
  it("returns the saved document in the existing response shape", async () => {
    const fake = scriptedDb([
      { table: "documents", data: doc },
      { table: "document_versions", data: { filename: "old.pdf" } },
      { table: "documents", op: "update", data: doc },
      {
        table: "document_versions",
        op: "update",
        data: { filename: "new.pdf" },
      },
    ]);
    state.db = fake.db;
    const response = await request(app)
      .patch(path)
      .set("Authorization", "Bearer test")
      .send({ filename: "new" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ...doc,
      filename: "new.pdf",
      ...(path.startsWith("/library") ? { folder_id: "folder" } : {}),
    });
    fake.done();
  });
  it("returns 404 for an absent or inaccessible scoped document", async () => {
    const fake = scriptedDb([{ table: "documents", data: null }]);
    state.db = fake.db;
    const response = await request(app)
      .patch(path)
      .set("Authorization", "Bearer test")
      .send({ filename: "new" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ detail: "Document not found" });
    fake.done();
  });
  it("returns 400 for an empty filename", async () => {
    const fake = scriptedDb([
      { table: "documents", data: doc },
      { table: "document_versions", data: { filename: "old.pdf" } },
    ]);
    state.db = fake.db;
    const response = await request(app)
      .patch(path)
      .set("Authorization", "Bearer test")
      .send({ filename: " " });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ detail: "filename is required" });
    fake.done();
  });
  it("returns a sanitized 500 when saving the active version fails", async () => {
    const fake = scriptedDb([
      { table: "documents", data: doc },
      { table: "document_versions", data: { filename: "old.pdf" } },
      { table: "documents", op: "update", data: doc },
      {
        table: "document_versions",
        op: "update",
        error: { message: "private database details" },
      },
    ]);
    state.db = fake.db;
    const response = await request(app)
      .patch(path)
      .set("Authorization", "Bearer test")
      .send({ filename: "new" });
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      code: "internal_error",
      detail: "Something went wrong. Please try again.",
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "private database details",
    );
    fake.done();
  });
});
it("keeps unauthorized project renames concealed as 404", async () => {
  state.access.mockResolvedValue({ ok: true, projectRole: "viewer" });
  const fake = scriptedDb([]);
  state.db = fake.db;
  const response = await request(app)
    .patch(paths[0])
    .set("Authorization", "Bearer test")
    .send({ filename: "new" });
  expect(response.status).toBe(404);
  expect(response.body).toEqual({ detail: "Project not found" });
  fake.done();
});
