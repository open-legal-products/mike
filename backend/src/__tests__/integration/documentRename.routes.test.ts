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
// The project rename response is re-enriched with the active version's file
// metadata (the explorer keys its icons and previews off it), so that path
// runs one extra read the library paths do not.
const activeVersion = {
  id: "v2",
  storage_path: "actor/doc/new.pdf",
  pdf_storage_path: null,
  version_number: 3,
  filename: "new.pdf",
  source: "upload",
  file_type: "pdf",
  size_bytes: 1024,
  page_count: 2,
  textless_page_count: 1,
  content_sha256: "a".repeat(64),
};
const enrichedFields = {
  storage_path: activeVersion.storage_path,
  pdf_storage_path: null,
  active_version_number: activeVersion.version_number,
  source: activeVersion.source,
  file_type: activeVersion.file_type,
  size_bytes: activeVersion.size_bytes,
  page_count: activeVersion.page_count,
  textless_page_count: activeVersion.textless_page_count,
  content_sha256: activeVersion.content_sha256,
};
const paths = [
  "/projects/p/documents/doc",
  "/library/files/documents/doc",
  "/library/templates/documents/doc",
];

describe.each(paths)("rename response compatibility: %s", (path) => {
  const isProject = !path.startsWith("/library");
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
      ...(isProject
        ? [{ table: "document_versions", data: [activeVersion] }]
        : []),
    ]);
    state.db = fake.db;
    const response = await request(app)
      .patch(path)
      .set("Authorization", "Bearer test")
      .send({ filename: "new" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ...doc,
      ...(isProject ? enrichedFields : {}),
      filename: "new.pdf",
      ...(isProject ? {} : { folder_id: "folder" }),
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
// A Viewer can OPEN the project, so 404 was a lie the UI then repeated
// ("this matter no longer exists"). The refusal names the missing permission
// instead; only a caller checkProjectAccess itself refuses still gets 404.
it("refuses a viewer's project rename by name, not as a missing project", async () => {
  state.access.mockResolvedValue({ ok: true, projectRole: "viewer" });
  const fake = scriptedDb([]);
  state.db = fake.db;
  const response = await request(app)
    .patch(paths[0])
    .set("Authorization", "Bearer test")
    .send({ filename: "new" });
  expect(response.status).toBe(403);
  expect(response.body).toEqual({
    detail: "You do not have permission to organize documents in this project.",
  });
  fake.done();
});

it("keeps 404 when the caller has no project access at all", async () => {
  state.access.mockResolvedValue({ ok: false });
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
