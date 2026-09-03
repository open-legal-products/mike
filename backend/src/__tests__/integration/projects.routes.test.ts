import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, deleteUserProjects } = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    deleteUserProjects: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Configurable Supabase stub. Each test seeds `supabaseState` in beforeEach;
// terminal query operations (.single()/.maybeSingle()/thenable) resolve to the
// per-table result, and rpc() resolves to a per-call result. Insert payloads
// are recorded so tests can assert on normalisation (lowercasing / dedupe).
// ---------------------------------------------------------------------------
type QueryResult = { data: unknown; error: unknown };

let supabaseState: {
    rpc: QueryResult;
    tables: Record<string, QueryResult>;
    inserts: { table: string; payload: unknown }[];
};

function resetSupabaseState() {
    supabaseState = {
        rpc: { data: [], error: null },
        tables: {},
        inserts: [],
    };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    return supabaseState.tables[table] ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    const chain = [
    "select",
    "update",
    "delete",
    "upsert",
    "eq",
    "neq",
    "in",
    "is",
    "or",
    "not",
    "lt",
    "gt",
    "gte",
    "lte",
    "filter",
    "order",
    "limit",
    "range",
    "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: unknown) => {
        supabaseState.inserts.push({ table, payload });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.maybeSingle = vi.fn(() => Promise.resolve(resultForTable(table)));
  q.then = (
    resolve: (v: unknown) => unknown,
    reject?: (e: unknown) => unknown,
  ) => Promise.resolve(resultForTable(table)).then(resolve, reject);
    return q;
}

function mockSupabase() {
    return {
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(() => Promise.resolve(supabaseState.rpc)),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => mockSupabase()),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

// Every export of lib/access must be present — other routers (chat, documents,
// downloads, tabular) import from it at app load.
vi.mock("../../lib/access", () => ({
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
}));

// user router imports all four cleanup helpers at module load.
vi.mock("../../lib/userDataCleanup", () => ({
    deleteUserProjects: (...args: unknown[]) => deleteUserProjects(...args),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
}));

// Version-path enrichment hits the DB in real life; no-op it so the route
// responses are driven purely by the documents/projects table stubs.
vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import crypto from "crypto";
import { manifestPublicKey } from "../../lib/manifestSigning";
import { createServerSupabase, type Db } from "../../lib/supabase";

const SIGNING_KEY = "3b".repeat(32);

const AUTH = ["Authorization", "Bearer test"] as const;

// Wraps mockSupabase()'s rpc so the next request's exact RPC call args can be
// asserted on — the shared mock otherwise only lets tests control the
// *response*, not inspect what was sent.
function captureRpcArgs(): { args: unknown; name: string | undefined } {
  const captured: { args: unknown; name: string | undefined } = {
    args: undefined,
    name: undefined,
  };
    vi.mocked(createServerSupabase).mockImplementationOnce(() => {
        const db = mockSupabase();
        const originalRpc = db.rpc;
        db.rpc = vi.fn((name: string, args: unknown) => {
      captured.name = name;
            captured.args = args;
            return originalRpc(name, args as never);
        });
        return db as unknown as Db;
    });
    return captured;
}

describe("projects.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isOwner: true,
            project: { id: "p1", user_id: "u1", shared_with: null },
        });
        deleteUserProjects.mockResolvedValue(1);
    });

    // ── GET /projects (overview) ──────────────────────────────────────────
    describe("GET /projects", () => {
        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [{ id: "p1", name: "Alpha" }],
                error: null,
            };

      const res = await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "p1", name: "Alpha" }]);
        });

        it("includes documents and subfolders in the batched directory response", async () => {
            supabaseState.rpc = {
                data: [{ id: "p1", name: "Alpha" }],
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        project_id: "p1",
                        folder_id: "f1",
                        filename: "Agreement.pdf",
                    },
                ],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [
                    {
                        id: "f1",
                        project_id: "p1",
                        parent_folder_id: null,
                        name: "Closing",
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .get("/projects?include=documents")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body[0]).toMatchObject({
                id: "p1",
                documents: [{ id: "d1", folder_id: "f1" }],
                folders: [{ id: "f1", name: "Closing" }],
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });

    // Regression guard: legacy project pickers call GET /projects with no
    // query params and need the full, unpaginated list back.
        it("calls the legacy 2-arg RPC shape when no pagination params are present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

      await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
            });
        });

        it("calls the paginated RPC shape with every filter parsed once any pagination param is present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

            await request(app)
                .get(
                    "/projects?limit=10&scope=mine&sort_key=name&sort_direction=asc" +
                        "&search=acme&practice=Litigation&owner_user_id=u2",
                )
                .set(...AUTH);

            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_scope: "mine",
                p_limit: 10,
                p_offset: 0,
                p_search_term: "acme",
                p_sort_key: "name",
                p_sort_direction: "asc",
                p_practice: "Litigation",
                p_owner_user_id: "u2",
            });
        });

    it("uses the lightweight summary RPC for view=summary", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [{ id: "p1", name: "Recently updated" }],
        error: null,
      };

      const res = await request(app)
        .get("/projects?view=summary&limit=11&offset=10")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { id: "p1", name: "Recently updated" },
      ]);
      expect(captured.name).toBe("get_project_summaries");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_user_email: "u1@test.local",
        p_limit: 11,
        p_offset: 10,
      });
    });

    it("uses the projects collection for directory search", async () => {
      const res = await request(app)
        .get("/projects?view=directory-search")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("no longer exposes a separate project directory search route", async () => {
      const res = await request(app)
        .get("/projects/directory/search?search=Agreement")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });
    });

    // ── GET /projects/ids (select-all-matching support) ──────────────────
    describe("GET /projects/ids", () => {
        it("pages through the RPC until an empty page is returned", async () => {
            const rpcMock = vi
                .fn()
                .mockResolvedValueOnce({
                    data: [{ id: "p1", user_id: "u1" }],
                    error: null,
                })
                .mockResolvedValueOnce({ data: [], error: null });
            vi.mocked(createServerSupabase).mockImplementationOnce(() => {
                const db = mockSupabase();
                db.rpc = rpcMock;
                return db as unknown as Db;
            });

      const res = await request(app)
        .get("/projects/ids")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "p1", user_id: "u1" }]);
            expect(rpcMock).toHaveBeenCalledTimes(2);
            expect(rpcMock.mock.calls[0][0]).toBe("get_project_ids_overview");
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/projects/ids")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

  describe("GET /projects/filter-options", () => {
    it("returns lightweight practice and owner facets", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [
          {
            practices: ["Litigation"],
            owners: [{ value: "u1", label: "Me" }],
          },
        ],
        error: null,
      };

      const res = await request(app)
        .get("/projects/filter-options")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        practices: ["Litigation"],
        owners: [{ value: "u1", label: "Me" }],
      });
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_user_email: "u1@test.local",
      });
    });
  });

  describe("Library query endpoints", () => {
    it("returns the ancestor path for a Library folder", async () => {
      supabaseState.tables.library_folders = {
        data: [
          {
            id: "nested",
            name: "Nested",
            parent_folder_id: "parent",
          },
          {
            id: "unrelated",
            name: "Unrelated",
            parent_folder_id: null,
          },
          {
            id: "parent",
            name: "Parent",
            parent_folder_id: null,
          },
        ],
        error: null,
      };

      const res = await request(app)
        .get("/library/templates/folders/nested")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body.folders.map((folder: { id: string }) => folder.id)).toEqual([
        "parent",
        "nested",
      ]);
    });

    it("returns 404 for a Library folder outside the requested collection", async () => {
      supabaseState.tables.library_folders = { data: [], error: null };

      const res = await request(app)
        .get("/library/files/folders/missing")
        .set(...AUTH);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ detail: "Folder not found" });
    });

    it("returns a flat paginated search result", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [
          { id: "d1", filename: "Agreement.docx" },
          { id: "d2", filename: "Agreement schedule.docx" },
        ],
        error: null,
      };

      const res = await request(app)
        .get(
          "/library/templates?view=search&limit=1&offset=2&search=Agreement" +
            "&file_type=docx&sort_key=name&sort_direction=asc",
        )
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        documents: [
          {
            id: "d1",
            filename: "Agreement.docx",
            folder_id: null,
          },
        ],
        documentsHasMore: true,
      });
      expect(captured.name).toBe("search_library_documents");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_library_kind: "template",
        p_limit: 2,
        p_offset: 2,
        p_search_term: "Agreement",
        p_file_type: "docx",
        p_sort_key: "name",
        p_sort_direction: "asc",
      });
    });

    it("no longer exposes a separate Library search route", async () => {
      const res = await request(app)
        .get("/library/templates/search?search=Agreement")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });

    it("returns only the file-type facet payload", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [{ file_types: ["docx", "pdf"] }],
        error: null,
      };

      const res = await request(app)
        .get("/library/files/filter-options")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ fileTypes: ["docx", "pdf"] });
      expect(captured.name).toBe("get_library_filter_options");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_library_kind: "file",
      });
    });
  });

  describe("folder upload path resolution", () => {
    it("resolves a project path through the atomic RPC", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: {
          conflict: false,
          folder_id: "folder-2",
          resolved_name: "NDAs (2)",
          folders: [],
        },
        error: null,
      };

      const res = await request(app)
        .post("/projects/p1/folder-paths/resolve")
        .set(...AUTH)
        .send({
          segments: ["NDAs"],
          base_folder_id: null,
          conflict_resolution: "rename",
        });

      expect(res.status).toBe(200);
      expect(res.body.resolved_name).toBe("NDAs (2)");
      expect(captured.name).toBe("resolve_project_folder_path");
      expect(captured.args).toEqual({
        target_project_id: "p1",
        target_user_id: "u1",
        base_folder_id: null,
        path_segments: ["NDAs"],
        conflict_resolution: "rename",
      });
    });

    it("returns project folder conflicts without replacement permissions", async () => {
      checkProjectAccess.mockResolvedValue({
        ok: true,
        isOwner: false,
        project: { id: "p1", user_id: "u2", shared_with: ["u1@test.local"] },
      });
      supabaseState.rpc = {
        data: {
          conflict: true,
          folder_name: "NDAs",
          existing_folder_id: "folder-1",
          suggested_name: "NDAs (2)",
        },
        error: null,
      };

      const res = await request(app)
        .post("/projects/p1/folder-paths/resolve")
        .set(...AUTH)
        .send({ segments: ["NDAs"] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        conflict: true,
        folder_name: "NDAs",
        existing_folder_id: "folder-1",
        suggested_name: "NDAs (2)",
      });
      expect(res.body).not.toHaveProperty("can_replace");
    });

    it("returns library folder conflicts without replacement permissions", async () => {
      supabaseState.rpc = {
        data: {
          conflict: true,
          folder_name: "NDAs",
          existing_folder_id: "folder-1",
          suggested_name: "NDAs (3)",
        },
        error: null,
      };

      const res = await request(app)
        .post("/library/files/folder-paths/resolve")
        .set(...AUTH)
        .send({ segments: ["NDAs"] });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        conflict: true,
        folder_name: "NDAs",
        existing_folder_id: "folder-1",
        suggested_name: "NDAs (3)",
      });
      expect(res.body).not.toHaveProperty("can_replace");
    });

    it.each([
      ["project", "/projects/p1/folder-paths/resolve"],
      ["library", "/library/files/folder-paths/resolve"],
    ])("does not expose raw %s folder RPC errors", async (_scope, path) => {
      const rawError =
        "Could not find resolve_project_folder_path in the schema cache";
      supabaseState.rpc = {
        data: null,
        error: { message: rawError },
      };
      const consoleError = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      const res = await request(app)
        .post(path)
        .set(...AUTH)
        .send({ segments: ["NDAs"] });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        code: "internal_error",
        detail: "Something went wrong. Please try again.",
      });
      expect(res.body.request_id).toEqual(expect.any(String));
      expect(JSON.stringify(res.body)).not.toContain(rawError);
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("rejects malformed path segments before calling the RPC", async () => {
      const captured = captureRpcArgs();

      const res = await request(app)
        .post("/library/files/folder-paths/resolve")
        .set(...AUTH)
        .send({ segments: ["NDAs", 42] });

      expect(res.status).toBe(400);
      expect(res.body.detail).toBe("Invalid folder path");
      expect(captured.name).toBeUndefined();
    });
  });

    // ── POST /projects (create) ───────────────────────────────────────────
    describe("POST /projects", () => {
        it("returns 400 when name is missing/blank", async () => {
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "   " });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("name is required");
        });

        it("returns 400 when sharing the project with yourself", async () => {
            // The authed user's email is u1@test.local; supplying it (in any
            // case) must be rejected.
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Beta", shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
      expect(res.body.detail).toBe("You cannot share a project with yourself.");
        });

        it("creates the project (201) and normalises shared_with", async () => {
            // Sharing requires each recipient to have a mirrored user_profiles
            // row (findMissingUserEmails); seed both emails so validation
            // passes and the create path proceeds.
            supabaseState.tables.user_profiles = {
                data: [{ email: "a@x.com" }, { email: "b@x.com" }],
                error: null,
            };
            supabaseState.tables.projects = {
                data: {
                    id: "p9",
                    name: "Gamma",
                    user_id: "u1",
                    shared_with: ["a@x.com", "b@x.com"],
                },
                error: null,
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({
                    name: "  Gamma  ",
                    shared_with: ["A@x.com", "a@x.com", "B@X.com", "", "  "],
                });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ id: "p9", documents: [] });

            // The insert payload should be lowercased, deduped, trimmed and
            // the name trimmed.
      const insert = supabaseState.inserts.find((i) => i.table === "projects");
            expect(insert?.payload).toMatchObject({
                name: "Gamma",
                shared_with: ["a@x.com", "b@x.com"],
            });
        });

        it("returns 400 when a shared_with recipient is not a Mike user", async () => {
            // No user_profiles rows seeded → findMissingUserEmails reports the
            // recipient as unknown and the create is rejected before insert.
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Gamma", shared_with: ["ghost@x.com"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "ghost@x.com does not belong to a Mike user.",
            );
            expect(
                supabaseState.inserts.find((i) => i.table === "projects"),
            ).toBeUndefined();
        });

        it("returns 500 when the insert errors", async () => {
            supabaseState.tables.projects = {
                data: null,
                error: { message: "insert failed" },
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Delta" });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── GET /projects/:projectId (detail, shared access helper) ───────────
    describe("GET /projects/:projectId", () => {
        it("returns 404 when the project does not exist", async () => {
            supabaseState.tables.projects = { data: null, error: null };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 404 when the caller is neither owner nor shared", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
            expect(checkProjectAccess).toHaveBeenCalledWith(
                "p1",
                "u1",
                "u1@test.local",
                expect.anything(),
            );
        });

        it("delegates mixed-case shared access to the case-insensitive helper", async () => {
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isOwner: false,
                project: {
                    id: "p1",
                    user_id: "someone-else",
                    shared_with: ["U1@Test.Local"],
                },
            });
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                    shared_with: ["U1@Test.Local"],
                },
                error: null,
            };
            supabaseState.tables.documents = { data: [], error: null };
            supabaseState.tables.project_subfolders = { data: [], error: null };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ id: "p1", is_owner: false });
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });

        it("returns 200 with documents/folders/is_owner when owned", async () => {
            supabaseState.tables.projects = {
                data: { id: "p1", user_id: "u1", shared_with: null },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", user_id: "u1" }],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1" }],
                error: null,
            };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: "p1",
                is_owner: true,
                documents: [{ id: "d1" }],
                folders: [{ id: "f1" }],
            });
        });
    });

    // ── GET /projects/:projectId/documents (checkProjectAccess guard) ─────
    describe("GET /projects/:projectId/documents", () => {
        it("returns 404 when checkProjectAccess denies access", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/projects/p1/documents")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });

        it("returns 200 with documents when access is granted", async () => {
            supabaseState.tables.documents = {
                data: [{ id: "d1" }, { id: "d2" }],
                error: null,
            };

            const res = await request(app)
                .get("/projects/p1/documents")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "d1" }, { id: "d2" }]);
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });
    });

    // ── PATCH /projects/:projectId (sharing normalisation) ────────────────
    describe("PATCH /projects/:projectId", () => {
        it("returns 400 when sharing the project with yourself", async () => {
            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ shared_with: ["u1@test.local"] });

            expect(res.status).toBe(400);
      expect(res.body.detail).toBe("You cannot share a project with yourself.");
        });

        it("returns 404 when the update matches no owned project", async () => {
            supabaseState.tables.projects = { data: null, error: null };

            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ name: "Renamed" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });
    });

    // ── DELETE /projects/:projectId ───────────────────────────────────────
    describe("DELETE /projects/:projectId", () => {
        it("returns 404 when nothing was deleted", async () => {
            deleteUserProjects.mockResolvedValue(0);

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 204 when the project is deleted", async () => {
            deleteUserProjects.mockResolvedValue(1);

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(204);
            // Signature is deleteUserProjects(db, userId, [projectId]).
      expect(deleteUserProjects).toHaveBeenCalledWith(expect.anything(), "u1", [
        "p1",
      ]);
        });

        it("returns 500 when deletion throws", async () => {
            deleteUserProjects.mockRejectedValue(new Error("cascade failed"));

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });
    // ── GET /projects/:projectId/export (tamper-evident manifest) ─────────
    describe("GET /projects/:projectId/export", () => {
        function seedProjectWithOneVersion() {
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    name: "Alpha",
                    cm_number: "CM-1",
                    created_at: "2026-01-01T00:00:00Z",
                },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        project_id: "p1",
                        status: "ready",
                        current_version_id: "v1",
                        created_at: "2026-01-02T00:00:00Z",
                    },
                ],
                error: null,
            };
            supabaseState.tables.document_versions = {
                data: [
                    {
                        id: "v1",
                        document_id: "d1",
                        version_number: 1,
                        source: "upload",
                        filename: "lease.docx",
                        file_type: "docx",
                        size_bytes: 12,
                        content_sha256: "a".repeat(64),
                        deleted_at: null,
                        created_at: "2026-01-02T00:00:00Z",
                    },
                ],
                error: null,
            };
            supabaseState.tables.document_edits = {
                data: [
                    {
                        id: "e1",
                        document_id: "d1",
                        version_id: "v1",
                        change_id: "c1",
                        status: "accepted",
                        created_at: "2026-01-03T00:00:00Z",
                        resolved_at: "2026-01-03T01:00:00Z",
                    },
                ],
                error: null,
            };
        }

        it("returns 404 when the caller cannot access the project", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns the version hashes and the edit trail as an attachment", async () => {
            seedProjectWithOneVersion();

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.headers["content-disposition"]).toMatch(
                /attachment; filename="mike-project-manifest-p1-/,
            );
            expect(res.body.manifest_version).toBe(1);
            expect(res.body.project.name).toBe("Alpha");
            const doc = res.body.documents[0];
            expect(doc.versions[0].content_sha256).toBe("a".repeat(64));
            expect(doc.edits[0].status).toBe("accepted");
        });

        it("carries a digest and no signature when signing is not configured", async () => {
            seedProjectWithOneVersion();

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.body.signature).toBeNull();
            expect(res.body.digest.algorithm).toBe("sha256");
            expect(res.body.digest.value).toMatch(/^[0-9a-f]{64}$/);
        });

        it("signs the digest when MANIFEST_SIGNING_KEY is set", async () => {
            process.env.MANIFEST_SIGNING_KEY = SIGNING_KEY;
            try {
                seedProjectWithOneVersion();

                const res = await request(app)
                    .get("/projects/p1/export")
                    .set(...AUTH);

                // Checked the way a recipient would: pin the published key,
                // rebuild the signed payload, verify with plain Ed25519.
                const published = manifestPublicKey()!;
                expect(res.body.signature.algorithm).toBe("ed25519");
                expect(res.body.signature.public_key).toBe(published.public_key);
                const spki = Buffer.concat([
                    Buffer.from("302a300506032b6570032100", "hex"),
                    Buffer.from(published.public_key, "hex"),
                ]);
                const payload = Buffer.concat([
                    Buffer.from("mike-project-manifest-v1\0", "utf8"),
                    Buffer.from(res.body.digest.value, "hex"),
                ]);
                expect(
                    crypto.verify(
                        null,
                        payload,
                        crypto.createPublicKey({
                            key: spki,
                            format: "der",
                            type: "spki",
                        }),
                        Buffer.from(res.body.signature.value, "hex"),
                    ),
                ).toBe(true);
            } finally {
                delete process.env.MANIFEST_SIGNING_KEY;
            }
        });

        it("does not leak the underlying error when the manifest build fails", async () => {
            supabaseState.tables.projects = {
                data: null,
        error: { message: 'relation "projects" does not exist' },
            };

            const res = await request(app)
                .get("/projects/p1/export")
                .set(...AUTH);

            expect(res.status).toBe(500);
      expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });
});
