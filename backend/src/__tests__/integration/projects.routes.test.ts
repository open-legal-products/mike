import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import {
    supabaseState,
    resetSupabaseState,
    mockSupabase,
    makeQuery,
} from "../helpers/supabaseMock";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, deleteProjectsByIds } = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    deleteProjectsByIds: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Supabase + auth stubs, shared with the other route suites via ../helpers/.
// Every suite here mounts `app`, which loads every router, so they all need the
// same fakes; see helpers/supabaseMock.ts for how `supabaseState` (seeded in
// beforeEach below) drives the responses.
//
// `vi.mock` factories are hoisted above the imports, so they cannot close over
// a top-level import binding — they pull the helper in dynamically instead. The
// explicit ".js" is what TypeScript's node16 module resolution requires of a
// dynamic (ECMAScript) import; Vite resolves it back to the .ts source, and
// both specifiers resolve to the same module instance as the static import
// above, so the state object the tests mutate is the one the stub reads.
// ---------------------------------------------------------------------------
vi.mock("../../lib/supabase", async () => {
    const { mockSupabase } = await import("../helpers/supabaseMock.js");
    return { createServerSupabase: vi.fn(() => mockSupabase()) };
});

vi.mock("../../middleware/auth", async () => {
    const { authMock } = await import("../helpers/authMock.js");
    return authMock();
});

// Every export of lib/access must be present — other routers (chat, documents,
// downloads, tabular) import from it at app load.
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: vi.fn(async () => null),
    resolveContentOrgId: vi.fn(async () => null),
}));

// user router imports all four cleanup helpers at module load.
vi.mock("../../modules/user/user.dataCleanup", () => ({
    deleteProjectsByIds: (...args: unknown[]) => deleteProjectsByIds(...args),
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
import { attachActiveVersionPaths } from "../../lib/documentVersions";

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
            isCreator: true,
            orgRole: null,
            projectRole: "owner",
            project: { id: "p1", user_id: "u1", org_id: null },
        });
        deleteProjectsByIds.mockResolvedValue(1);
    });

    describe("PATCH /projects/:projectId/documents/:documentId", () => {
        it.each(["pdf", "docx", "xlsx", "pptx"])(
            "preserves active %s version metadata after renaming",
            async (fileType) => {
                const version = {
                    id: "v1",
                    filename: `Original.${fileType}`,
                    file_type: fileType,
                    storage_path: `u1/doc-1/original.${fileType}`,
                    pdf_storage_path: "u1/doc-1/preview.pdf",
                    version_number: 3,
                    size_bytes: 1024,
                    page_count: 2,
                    source: "upload",
                };
                supabaseState.tables.documents = {
                    data: {
                        id: "doc-1",
                        project_id: "p1",
                        current_version_id: "v1",
                    },
                    error: null,
                };
                supabaseState.tables.document_versions = {
                    data: version,
                    error: null,
                };
                vi.mocked(createServerSupabase).mockImplementationOnce(() => {
                    const db = mockSupabase();
                    db.from = vi.fn((table: string) => {
                        const query = makeQuery(table);
                        if (table === "document_versions") {
                            query.update = vi.fn(
                                (payload: Partial<typeof version>) => {
                                    Object.assign(version, payload);
                                    return query;
                                },
                            );
                            query.then = (resolve: (value: unknown) => unknown) =>
                                Promise.resolve({ data: [version], error: null }).then(
                                    resolve,
                                );
                        }
                        return query;
                    });
                    return db as unknown as ReturnType<typeof createServerSupabase>;
                });
                const actual = await vi.importActual<
                    typeof import("../../lib/documentVersions")
                >("../../lib/documentVersions");
                vi.mocked(attachActiveVersionPaths).mockImplementationOnce(
                    actual.attachActiveVersionPaths,
                );

                const res = await request(app)
                    .patch("/projects/p1/documents/doc-1")
                    .set(...AUTH)
                    .send({ filename: "Renamed document" });

                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({
                    id: "doc-1",
                    filename: `Renamed document.${fileType}`,
                    file_type: fileType,
                    storage_path: version.storage_path,
                    pdf_storage_path: version.pdf_storage_path,
                    active_version_number: 3,
                    size_bytes: 1024,
                    page_count: 2,
                });
                expect(version.filename).toBe(`Renamed document.${fileType}`);
            },
        );

        it("does not report a successful rename when the version update fails", async () => {
            supabaseState.tables.documents = {
                data: { id: "doc-1", project_id: "p1", current_version_id: "v1" },
                error: null,
            };
            supabaseState.tables.document_versions = {
                data: { filename: "Original.pdf" },
                error: { message: "private database failure" },
            };

            const res = await request(app)
                .patch("/projects/p1/documents/doc-1")
                .set(...AUTH)
                .send({ filename: "Renamed.pdf" });

            expect(res.status).toBe(500);
            expect(JSON.stringify(res.body)).not.toContain("private database failure");
            expect(attachActiveVersionPaths).not.toHaveBeenCalled();
        });
    });

    // ── GET /projects (overview) ──────────────────────────────────────────
    describe("GET /projects", () => {
        it.each(["owner", "admin"])("keeps an org %s's public and private project participation scoped to its workspace", async (orgRole) => {
            const orgId = "7b1d9d0e-3c5a-4f6e-9a51-0c2f7d3e8a11";
            const inheritedRole = orgRole === "owner" ? "owner" : "editor";
            const projects = [
                { id: "created-public", user_id: "u1", access_scope: "organization", access_role: "owner" },
                { id: "created-private", user_id: "u1", access_scope: "private", access_role: "owner" },
                { id: "shared-private", user_id: "other", access_scope: "shared", access_role: "viewer" },
                { id: "other-public", user_id: "other", access_scope: "organization", access_role: inheritedRole },
                { id: "audited-private", user_id: "other", access_scope: "private", access_role: "viewer" },
                { id: "ownerless-private", user_id: null, access_scope: "private", access_role: "owner" },
            ].map(project => ({ ...project, org_id: orgId, organization_name: "Example Org" }));
            // Public-item roles for org owners are implicit. Admins can also
            // hold an explicit project role, which does count as participation.
            if (orgRole === "admin") projects.push({
                id: "shared-public", user_id: "other", access_scope: "organization",
                access_role: "editor", org_id: orgId, organization_name: "Example Org",
            });
            const otherWorkspace = { ...projects[0], id: "other-workspace", org_id: "another-org" };
            const personal = { ...projects[1], id: "personal", org_id: null, organization_name: null };
            supabaseState.tables.org_members = { data: { org_id: orgId, role: orgRole }, error: null };
            supabaseState.rpc = { data: [...projects, otherWorkspace, personal], error: null };
            supabaseState.tables.project_org_access_overrides = {
                data: ["shared-private", ...(orgRole === "admin" ? ["shared-public"] : [])].map(project_id => ({ project_id })),
                error: null,
            };
            const picker = await request(app).get(`/projects?participating=true&workspace=${orgId}`).set(...AUTH);
            expect(picker.status).toBe(200);
            expect(picker.body.map((p: { id: string }) => p.id)).toEqual([
                "created-public", "created-private", "shared-private",
                ...(orgRole === "admin" ? ["shared-public"] : []),
            ]);
            expect(supabaseState.rpcCalls[0]).toEqual({ fn: "get_projects_overview", args: { p_user_id: "u1", p_user_email: "u1@test.local" } });
            const overview = await request(app).get("/projects").set(...AUTH);
            expect(overview.status).toBe(200);
            expect(overview.body.map((p: { id: string }) => p.id)).toEqual([...projects, otherWorkspace, personal].map(p => p.id));
        });

        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [
                    {
                        id: "p1",
                        name: "Alpha",
                        org_id: "org-1",
                        access_scope: "organization",
                        organization_name: "Elite Law LLP",
                    },
                ],
                error: null,
            };

      const res = await request(app)
        .get("/projects")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                {
                    id: "p1",
                    name: "Alpha",
                    org_id: "org-1",
                    access_scope: "organization",
                    organization_name: "Elite Law LLP",
                    memory_enabled: true,
                },
            ]);
        });

        it("adds creator photos to the paginated overview only", async () => {
            supabaseState.rpc = {
                data: [{ id: "p1", user_id: "u2", access_scope: "private", organization_name: null }],
                error: null,
            };
            supabaseState.tables.user_profiles = {
                data: [{ user_id: "u2", display_name: "Ada", profile_photo: "data:image/png;base64,AAAA" }],
                error: null,
            };
            const overview = await request(app).get("/projects?limit=20").set(...AUTH);
            expect(overview.status).toBe(200);
            expect(overview.body[0].owner_profile_photo).toBe("data:image/png;base64,AAAA");

            const picker = await request(app).get("/projects").set(...AUTH);
            expect(picker.status).toBe(200);
            expect(picker.body[0]).not.toHaveProperty("owner_profile_photo");
        });

        it("backfills organization access when the overview RPC is stale", async () => {
            supabaseState.rpc = {
                data: [{ id: "p1", name: "Firm matter", is_owner: true }],
                error: null,
            };
            supabaseState.tables.projects = {
                data: [{ id: "p1", org_id: "org-1" }],
                error: null,
            };
            supabaseState.tables.project_access_grants = {
                data: [],
                error: null,
            };
            supabaseState.tables.organizations = {
                data: [{ id: "org-1", name: "Elite Law LLP" }],
                error: null,
            };

            const res = await request(app).get("/projects").set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                {
                    id: "p1",
                    name: "Firm matter",
                    is_owner: true,
                    org_id: "org-1",
                    access_scope: "organization",
                    organization_name: "Elite Law LLP",
                    memory_enabled: true,
                },
            ]);
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
        { id: "p1", name: "Recently updated", memory_enabled: true },
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

    // ── directory search vs. the deny override ─────────────────────────
    // The picker's org branch used to be plain membership: `projects` where
    // org_id IN (my orgs), with no per-project verdict. Every other path
    // resolves through checkProjectAccess / project_access_role, which
    // refuse on a deny — so the picker was handing a walled-off member the
    // matter's name, cm_number and its document filenames.
    //
    // The shared stub answers per TABLE, and this route reads the same
    // `projects` table three different ways, so these two tests use a
    // filter-aware db instead.
    function directorySearchDb(options: {
      personal?: Record<string, unknown>[];
      orgProjects?: Record<string, unknown>[];
      memberships?: { org_id: string; role: string }[];
      denies?: string[];
      /** Per-project grants the caller holds: project id -> role. */
      grants?: Record<string, string>;
      /** Private projects the database reports as having no Owner left. */
      ownerless?: string[];
    }) {
      const personal = options.personal ?? [];
      const orgProjects = options.orgProjects ?? [];
      const memberships = options.memberships ?? [];
      const overrides: Record<string, string> = {
        ...options.grants,
        ...Object.fromEntries(
          (options.denies ?? []).map((id) => [id, "deny"]),
        ),
      };

      const build = (resolve: (f: Record<string, unknown>) => unknown[]) => {
        const filters: Record<string, unknown> = {};
        const b: Record<string, unknown> = {};
        for (const method of ["select", "order", "limit", "range", "ilike"])
          b[method] = () => b;
        b.is = () => b;
        b.eq = (column: string, value: unknown) => {
          filters[`eq:${column}`] = value;
          return b;
        };
        b.in = (column: string, value: unknown) => {
          filters[`in:${column}`] = value;
          return b;
        };
        b.single = () =>
          Promise.resolve({ data: resolve(filters)[0] ?? null, error: null });
        b.maybeSingle = b.single;
        b.then = (onResolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: resolve(filters), error: null }).then(
            onResolve,
          );
        return b;
      };

      return {
        from: (table: string) => {
          if (table === "projects")
            return build((filters) => {
              if (filters["in:org_id"]) return orgProjects;
              if (filters["in:id"]) return [];
              return personal;
            });
          if (table === "project_org_access_overrides")
            // The override read is scoped by the caller's memberships
            // (org_id) and their user_id — never by every org project's id.
            return build((filters) => {
              const orgIds = (filters["in:org_id"] as string[] | undefined) ?? [];
              if (filters["in:project_id"]) return [];
              return orgProjects
                .filter(
                  (project) =>
                    (project.id as string) in overrides &&
                    orgIds.includes(project.org_id as string),
                )
                .map((project) => ({
                  project_id: project.id,
                  role: overrides[project.id as string],
                }));
            });
          if (table === "org_members") return build(() => memberships);
          return build(() => []);
        },
        rpc: (name?: string) =>
          Promise.resolve({
            data:
              name === "ownerless_org_item_ids"
                ? (options.ownerless ?? []).map((item_id) => ({
                    kind: "project",
                    item_id,
                  }))
                : [],
            error: null,
          }),
        auth: {
          getUser: () =>
            Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
      };
    }

    // Open to the whole organization, so it is a denial and nothing else
    // that walls a member off it.
    const WALLED = {
      id: "p-walled",
      name: "Matter P",
      cm_number: "2026-0042",
      org_id: "o1",
      user_id: "u2",
      visibility: "organization",
      updated_at: "2026-09-01T00:00:00Z",
    };
    const PRIVATE = { ...WALLED, id: "p-private", visibility: "private" };

    it("hides an org project the caller is denied on", async () => {
      vi.mocked(createServerSupabase).mockImplementationOnce(
        () =>
          directorySearchDb({
            memberships: [{ org_id: "o1", role: "member" }],
            orgProjects: [WALLED],
            denies: ["p-walled"],
          }) as unknown as ReturnType<typeof createServerSupabase>,
      );

      const res = await request(app)
        .get("/projects?view=directory-search&search=Matter")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("still returns the org project when no deny override exists", async () => {
      vi.mocked(createServerSupabase).mockImplementationOnce(
        () =>
          directorySearchDb({
            memberships: [{ org_id: "o1", role: "member" }],
            orgProjects: [WALLED],
          }) as unknown as ReturnType<typeof createServerSupabase>,
      );

      const res = await request(app)
        .get("/projects?view=directory-search&search=Matter")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body.map((project: { id: string }) => project.id)).toEqual([
        "p-walled",
      ]);
    });

    it("keeps an org owner's view of a project carrying a stale deny row", async () => {
      vi.mocked(createServerSupabase).mockImplementationOnce(
        () =>
          directorySearchDb({
            memberships: [{ org_id: "o1", role: "owner" }],
            orgProjects: [WALLED],
            denies: ["p-walled"],
          }) as unknown as ReturnType<typeof createServerSupabase>,
      );

      const res = await request(app)
        .get("/projects?view=directory-search&search=Matter")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body.map((project: { id: string }) => project.id)).toEqual([
        "p-walled",
      ]);
    });

    it("walls an org admin off a project they are denied on, like any member", async () => {
      vi.mocked(createServerSupabase).mockImplementationOnce(
        () =>
          directorySearchDb({
            memberships: [{ org_id: "o1", role: "admin" }],
            orgProjects: [WALLED],
            denies: ["p-walled"],
          }) as unknown as ReturnType<typeof createServerSupabase>,
      );

      const res = await request(app)
        .get("/projects?view=directory-search&search=Matter")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    // Private by default. The picker serves a project's name, matter number
    // and document filenames, so a private project must not appear in it for
    // a member it was not shared with.
    it.each(["member", "admin"])(
      "keeps a private org project out of an org %s's picker",
      async (role) => {
        vi.mocked(createServerSupabase).mockImplementationOnce(
          () =>
            directorySearchDb({
              memberships: [{ org_id: "o1", role }],
              orgProjects: [PRIVATE],
            }) as unknown as ReturnType<typeof createServerSupabase>,
        );

        const res = await request(app)
          .get("/projects?view=directory-search&search=Matter")
          .set(...AUTH);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
      },
    );

    it("does not offer an organization owner a member's private project", async () => {
      // Owning the organization is not a reason to see a colleague's
      // private matter in a picker, any more than to open it.
      vi.mocked(createServerSupabase).mockImplementationOnce(
        () =>
          directorySearchDb({
            memberships: [{ org_id: "o1", role: "owner" }],
            orgProjects: [PRIVATE],
          }) as unknown as ReturnType<typeof createServerSupabase>,
      );

      const res = await request(app)
        .get("/projects?view=directory-search&search=Matter")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("does not offer an admin a private project that has no Owner left", async () => {
      // Only the organization's owners take such a project over.
      vi.mocked(createServerSupabase).mockImplementationOnce(
        () =>
          directorySearchDb({
            memberships: [{ org_id: "o1", role: "admin" }],
            orgProjects: [PRIVATE],
            ownerless: ["p-private"],
          }) as unknown as ReturnType<typeof createServerSupabase>,
      );

      const res = await request(app)
        .get("/projects?view=directory-search&search=Matter")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("offers a private org project to a member it was shared with, and to an owner once it has no Owner left", async () => {
      for (const options of [
        { memberships: [{ org_id: "o1", role: "member" }], grants: { "p-private": "viewer" } },
        { memberships: [{ org_id: "o1", role: "owner" }], ownerless: ["p-private"] },
      ]) {
        vi.mocked(createServerSupabase).mockImplementationOnce(
          () =>
            directorySearchDb({
              ...options,
              orgProjects: [PRIVATE],
            }) as unknown as ReturnType<typeof createServerSupabase>,
        );

        const res = await request(app)
          .get("/projects?view=directory-search&search=Matter")
          .set(...AUTH);

        expect(res.status).toBe(200);
        expect(res.body.map((project: { id: string }) => project.id)).toEqual([
          "p-private",
        ]);
      }
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

  // ── Active workspace ────────────────────────────────────────────────
  // The list is narrowed in SQL (workspace_matches), so what these pin is
  // the route's half: the value is validated, membership is re-checked on
  // every request, and the RPC receives exactly what was asked for.
  describe("workspace filter", () => {
    const ORG = "7b1d9d0e-3c5a-4f6e-9a51-0c2f7d3e8a11";

    it.each(["personal", ORG])("keeps the full participation picker scoped to %s", async (workspace) => {
      supabaseState.tables.org_members = { data: { org_id: ORG }, error: null };
      const project = (id: string, org_id: string | null, user_id = "u1") => ({
        id, org_id, user_id, access_role: "owner",
        access_scope: org_id ? "organization" : "private",
        organization_name: org_id ? "Example Org" : null,
      });
      const personal = Array.from({ length: 40 }, (_, index) => project(`personal-${index}`, null));
      const organization = Array.from({ length: 40 }, (_, index) => project(`org-${index}`, ORG));
      supabaseState.rpc = {
        data: [...personal, ...organization, project("other-org", "another-org"), project("inherited", ORG, "other")],
        error: null,
      };
      supabaseState.tables.project_org_access_overrides = { data: [], error: null };
      const res = await request(app)
        .get(`/projects?participating=true&workspace=${workspace}`)
        .set(...AUTH);
      expect(res.status).toBe(200);
      expect(res.body.map((p: { id: string }) => p.id)).toEqual(
        (workspace === "personal" ? personal : organization).map(p => p.id),
      );
      // Workspace scoping must not opt the picker into the default page limit.
      expect(supabaseState.rpcCalls[0]).toEqual({
        fn: "get_projects_overview",
        args: { p_user_id: "u1", p_user_email: "u1@test.local" },
      });
    });

    it.each([
      ["/projects?limit=20", "get_projects_overview"],
      ["/projects?view=summary", "get_project_summaries"],
      ["/projects/ids", "get_project_ids_overview"],
      ["/projects/filter-options", "get_project_filter_options"],
    ])("calls %s without a workspace exactly as before", async (path, rpc) => {
      const captured = captureRpcArgs();
      const res = await request(app)
        .get(path)
        .set(...AUTH);
      expect(res.status).toBe(200);
      expect(captured.name).toBe(rpc);
      expect(captured.args).not.toHaveProperty("p_workspace");
    });

    it.each([
      ["/projects?limit=20&workspace=personal", "get_projects_overview"],
      ["/projects?view=summary&workspace=personal", "get_project_summaries"],
      ["/projects/ids?workspace=personal", "get_project_ids_overview"],
      [
        "/projects/filter-options?workspace=personal",
        "get_project_filter_options",
      ],
    ])("narrows %s to personal content", async (path, rpc) => {
      const captured = captureRpcArgs();
      const res = await request(app)
        .get(path)
        .set(...AUTH);
      expect(res.status).toBe(200);
      expect(captured.name).toBe(rpc);
      expect(captured.args).toMatchObject({ p_workspace: "personal" });
    });

    it("narrows to an organization the caller belongs to", async () => {
      supabaseState.tables.org_members = {
        data: { org_id: ORG },
        error: null,
      };
      const captured = captureRpcArgs();
      const res = await request(app)
        .get(`/projects?limit=20&workspace=${ORG}`)
        .set(...AUTH);
      expect(res.status).toBe(200);
      expect(captured.args).toMatchObject({ p_workspace: ORG });
    });

    it("treats a workspace on its own as a request for the paginated list", async () => {
      // Without this the request falls through to the unpaginated legacy
      // overload, which has no workspace parameter and would return
      // every workspace's projects.
      const captured = captureRpcArgs();
      const res = await request(app)
        .get("/projects?workspace=personal")
        .set(...AUTH);
      expect(res.status).toBe(200);
      expect(captured.args).toMatchObject({
        p_workspace: "personal",
        p_limit: expect.any(Number),
      });
    });

    it.each([
      "/projects?limit=20",
      "/projects?participating=true",
      "/projects?view=summary",
      "/projects/ids",
      "/projects/filter-options",
    ])(
      "404s %s for an organization the caller is not in, without listing anything",
      async (path) => {
        supabaseState.tables.org_members = { data: null, error: null };
        const captured = captureRpcArgs();
        const res = await request(app)
          .get(`${path}${path.includes("?") ? "&" : "?"}workspace=${ORG}`)
          .set(...AUTH);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({
          detail: "Workspace not found",
          code: "workspace_not_found",
        });
        expect(captured.name).toBeUndefined();
      },
    );

    it("400s a workspace that is neither 'personal' nor an id", async () => {
      const captured = captureRpcArgs();
      const res = await request(app)
        .get("/projects?limit=20&workspace=everything")
        .set(...AUTH);
      expect(res.status).toBe(400);
      expect(res.body.detail).toBe(
        "workspace must be 'personal' or an organization id",
      );
      expect(captured.name).toBeUndefined();
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
      supabaseState.tables.user_profiles = {
        data: [{ user_id: "u1", display_name: "Ada", email: "Ada@Test.local", profile_photo: "data:image/png;base64,AAAA" }],
        error: null,
      };

      const res = await request(app)
        .get("/projects/filter-options")
        .set(...AUTH);

      expect(res.status).toBe(200);
      // The Creator filter shows each owner with their avatar.
      expect(res.body).toEqual({
        practices: ["Litigation"],
        owners: [{
          value: "u1",
          label: "Me",
          display_name: "Ada",
          email: "ada@test.local",
          profile_photo: "data:image/png;base64,AAAA",
        }],
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

    // "Resolve" names a lookup, but the RPC behind it creates any folder in
    // the path that does not exist yet. A viewer's tier is read-only, so the
    // route has to refuse before it reaches the RPC — not merely return an
    // empty answer.
    it("refuses a viewer, who would otherwise create folders by resolving a path", async () => {
      const captured = captureRpcArgs();
      checkProjectAccess.mockResolvedValue({
        ok: true,
        isCreator: false,
        orgRole: null,
        projectRole: "viewer",
        project: {
          id: "p1",
          user_id: "u2",
          org_id: null,
        },
      });

      const res = await request(app)
        .post("/projects/p1/folder-paths/resolve")
        .set(...AUTH)
        .send({
          segments: ["NDAs"],
          base_folder_id: null,
          conflict_resolution: "rename",
        });

      // 403, not 404: the viewer can see this project, so claiming it does
      // not exist is a lie the UI then repeats to them.
      expect(res.status).toBe(403);
      expect(res.body.detail).toBe(
        "You do not have permission to organize documents in this project.",
      );
      expect(captured.name).toBeUndefined();
    });

    it("returns project folder conflicts without replacement permissions", async () => {
      checkProjectAccess.mockResolvedValue({
        ok: true,
        isCreator: false,
        orgRole: null,
        projectRole: "editor",
        project: { id: "p1", user_id: "u2", org_id: null },
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

        it("rejects the retired shared_with input", async () => {
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Beta", shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "shared_with is no longer supported; use the project access endpoints.",
            );
        });

        it("creates the project with normalized project details", async () => {
            supabaseState.rpc = {
                data: {
                    id: "p9",
                    name: "Gamma",
                    user_id: "u1",
                },
                error: null,
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({
                    name: "  Gamma  ",
                    practice: "  litigation  ",
                });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({
                id: "p9",
                documents: [],
                access_scope: "private",
                organization_name: null,
            });

            const db = vi.mocked(createServerSupabase).mock.results.at(-1)
                ?.value as ReturnType<typeof mockSupabase>;
            expect(db.rpc).toHaveBeenCalledWith("create_project_with_memory", {
                p_user_id: "u1",
                p_name: "Gamma",
                p_cm_number: null,
                p_practice: "litigation",
                p_org_id: null,
                p_memory_enabled: true,
            });
        });

        it("applies the creator's saved project-memory default", async () => {
            supabaseState.rpc = {
                data: { id: "p11", name: "Quiet", user_id: "u1" },
                error: null,
            };
            supabaseState.tables.user_profiles = {
                data: { project_memory_default: false },
                error: null,
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Quiet" });

            expect(res.status).toBe(201);
            expect(res.body.memory_enabled).toBe(false);
            const db = vi.mocked(createServerSupabase).mock.results.at(-1)
                ?.value as ReturnType<typeof mockSupabase>;
            expect(db.rpc).toHaveBeenCalledWith(
                "create_project_with_memory",
                expect.objectContaining({ p_memory_enabled: false }),
            );
        });

        it("defaults new projects to memory on when the preference is unreadable", async () => {
            supabaseState.rpc = {
                data: { id: "p12", name: "Legacy", user_id: "u1" },
                error: null,
            };
            // A database that has not applied the preference migration.
            supabaseState.tables.user_profiles = {
                data: null,
                error: { code: "42703", message: "project_memory_default" },
            };

            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Legacy" });

            expect(res.status).toBe(201);
            expect(res.body.memory_enabled).toBe(true);
        });

        it("commits an explicit memory opt-out in the same project transaction", async () => {
            supabaseState.rpc = {
                data: { id: "p10", name: "Private", user_id: "u1" },
                error: null,
            };
            const res = await request(app)
                .post("/projects")
                .set(...AUTH)
                .send({ name: "Private", memory_enabled: false });
            expect(res.status).toBe(201);
            expect(res.body.memory_enabled).toBe(false);
            const db = vi.mocked(createServerSupabase).mock.results.at(-1)
                ?.value as ReturnType<typeof mockSupabase>;
            expect(db.rpc).toHaveBeenCalledWith(
                "create_project_with_memory",
                expect.objectContaining({ p_memory_enabled: false }),
            );
            expect(supabaseState.inserts).toEqual([]);
        });

        it("returns 500 when the insert errors", async () => {
            supabaseState.rpc = {
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
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                },
                error: null,
            };

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

        it("grants direct access via the case-insensitive helper (member role)", async () => {
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "editor",
                project: {
                    id: "p1",
                    user_id: "someone-else",
                },
            });
            supabaseState.tables.projects = {
                data: {
                    id: "p1",
                    user_id: "someone-else",
                },
                error: null,
            };
            supabaseState.tables.documents = { data: [], error: null };
            supabaseState.tables.project_subfolders = { data: [], error: null };

      const res = await request(app)
        .get("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({
                id: "p1",
                is_owner: false,
                access_role: "editor",
            });
            expect(checkProjectAccess).toHaveBeenCalledTimes(1);
        });

        it("returns 200 with documents/folders/is_owner when owned", async () => {
            supabaseState.tables.projects = {
                data: { id: "p1", user_id: "u1" },
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

        it("labels documents and folders with their creator's name and photo", async () => {
            supabaseState.tables.projects = {
                data: { id: "p1", user_id: "u1" },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", user_id: "u2" }],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1", user_id: "u2" }],
                error: null,
            };
            supabaseState.tables.user_profiles = {
                data: [{ user_id: "u2", display_name: "Ada", profile_photo: "data:image/png;base64,AAAA" }],
                error: null,
            };

            const res = await request(app)
                .get("/projects/p1")
                .set(...AUTH);

            const creator = { owner_display_name: "Ada", owner_profile_photo: "data:image/png;base64,AAAA" };
            expect(res.status).toBe(200);
            expect(res.body.documents).toEqual([{ id: "d1", user_id: "u2", owner_email: null, ...creator }]);
            expect(res.body.folders).toEqual([{ id: "f1", user_id: "u2", ...creator }]);
        });
    });

    // ── GET /projects/:projectId/people ─────────────────────────────────
    // The roster is readable at every tier, viewers included. It is the same
    // list GET /chat/:chatId/people and GET /tabular-review/:reviewId/people
    // already serve for a project-owned row, so tiering it here only meant
    // the collaborator list was one request away. What stays owner-only is
    // the MANAGEMENT surface, GET /projects/:projectId/access.
    describe("GET /projects/:projectId/people", () => {
        const seedDirectProject = (projectRole: string) => {
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole,
                project: { id: "p1", user_id: "creator", org_id: null },
            });
            supabaseState.tables.user_profiles = {
                data: [
                    {
                        user_id: "creator",
                        email: "creator@test.local",
                        display_name: "Creator",
                    },
                    {
                        user_id: "u2",
                        email: "colleague@test.local",
                        display_name: "Colleague",
                        profile_photo: "data:image/png;base64,iVBORw0KGgo=",
                    },
                ],
                error: null,
            };
            supabaseState.tables.project_access_grants = {
                data: [
                    {
                        id: "g1",
                        project_id: "p1",
                        email: "colleague@test.local",
                        role: "editor",
                    },
                ],
                error: null,
            };
        };

        it.each(["viewer", "editor", "owner"])(
            "serves the full collaborator roster to a %s",
            async (projectRole) => {
                seedDirectProject(projectRole);

                const res = await request(app)
                    .get("/projects/p1/people")
                    .set(...AUTH);

                expect(res.status).toBe(200);
                expect(res.body.scope).toBe("direct");
                expect(res.body.owner).toMatchObject({
                    user_id: "creator",
                    role: "owner",
                });
                expect(res.body.members).toEqual([
                    {
                        user_id: "u2",
                        email: "colleague@test.local",
                        display_name: "Colleague",
                        profile_photo: "data:image/png;base64,iVBORw0KGgo=",
                        role: "editor",
                    },
                ]);
            },
        );

        it("still refuses somebody with no access at all", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/projects/p1/people")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("keeps the management surface owner-only", async () => {
            seedDirectProject("viewer");

            const res = await request(app)
                .get("/projects/p1/access")
                .set(...AUTH);

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(
                "Only a project owner can change who has access.",
            );
        });
    });

    // ── DELETE /projects/:projectId/folders/:folderId (role ladder) ──────
    // Organizing documents and folders is member work (Will's review): a
    // collaborator who may upload and delete documents is not meaningfully
    // restrained by being unable to remove the folder holding them. Only
    // viewers are refused.
    describe("DELETE /projects/:projectId/folders/:folderId", () => {
        const roleAccess = (projectRole: string) => ({
            ok: true,
            isCreator: projectRole === "owner",
            orgRole: null,
            projectRole,
            project: { id: "p1", user_id: "u1", org_id: null },
        });

        beforeEach(() => {
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1", parent_folder_id: null }],
                error: null,
            };
            supabaseState.tables.documents = { data: [], error: null };
        });

        it("allows a project owner (204)", async () => {
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(204);
        });

        it("allows an editor — folder work is editor-level (204)", async () => {
            checkProjectAccess.mockResolvedValue(roleAccess("editor"));
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(204);
        });

        it("blocks a viewer with a refusal, not a fake 404", async () => {
            checkProjectAccess.mockResolvedValue(roleAccess("viewer"));
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(
                "You do not have permission to organize documents in this project.",
            );
        });

        it("still answers 404 when the project is invisible", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });
            const res = await request(app)
                .delete("/projects/p1/folders/f1")
                .set(...AUTH);
            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });
    });

    // ── POST /projects/:projectId/folders (404 vs 403) ───────────────────
    // "Project not found" for a viewer who is looking straight at the
    // project is the bug: a refusal has to say it is a refusal.
    describe("POST /projects/:projectId/folders", () => {
        it("refuses a viewer with 403 and an intentional message", async () => {
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "viewer",
                project: { id: "p1", user_id: "u2", org_id: "o1" },
            });

            const res = await request(app)
                .post("/projects/p1/folders")
                .set(...AUTH)
                .send({ name: "Closing" });

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe(
                "You do not have permission to organize documents in this project.",
            );
            expect(supabaseState.inserts).toEqual([]);
        });

        it("keeps 404 for a project the caller cannot see at all", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/projects/p1/folders")
                .set(...AUTH)
                .send({ name: "Closing" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });
    });

    // ── GET /projects/:projectId/chats ────────────────────────────────────
    // The list has to say what the caller may DO with each chat, or the
    // client is left gating on `user_id === me` — which this PR's model makes
    // wrong in both directions.
    describe("GET /projects/:projectId/chats", () => {
        const seedChats = () => {
            supabaseState.tables.chats = {
                data: [
                    { id: "c-mine", user_id: "u1" },
                    { id: "c-theirs", user_id: "u2" },
                    { id: "c-shared", user_id: "u2" },
                ],
                error: null,
            };
            supabaseState.tables.chat_access_grants = {
                data: [{ chat_id: "c-shared", role: "editor" }],
                error: null,
            };
            supabaseState.tables.user_profiles = { data: [], error: null };
        };

        it("labels each chat with the caller's role for it", async () => {
            seedChats();
            // A project MEMBER: content collaboration, not administration.
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "member",
                projectRole: "editor",
                project: { id: "p1", user_id: "u2", org_id: "org-1" },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(
                (res.body as { id: string; access_role: string; is_owner: boolean }[]).map(
                    ({ id, access_role, is_owner }) => ({
                        id,
                        access_role,
                        is_owner,
                    }),
                ),
            ).toEqual([
                // Project children inherit the project verdict exactly, even
                // when the caller created a particular child row.
                { id: "c-mine", access_role: "editor", is_owner: true },
                // A colleague's: readable and writable, not deletable.
                { id: "c-theirs", access_role: "editor", is_owner: false },
                // Child grants do not alter inherited access.
                { id: "c-shared", access_role: "editor", is_owner: false },
            ]);
        });

        it("labels each chat with its creator's name and photo", async () => {
            seedChats();
            supabaseState.tables.user_profiles = {
                data: [{ user_id: "u2", display_name: "Ada", profile_photo: "data:image/png;base64,AAAA" }],
                error: null,
            };
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "owner",
                project: { id: "p1", user_id: "u1", org_id: null },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            expect(
                (res.body as { id: string; creator_display_name: string | null; creator_profile_photo: string | null }[]).map(
                    ({ id, creator_display_name, creator_profile_photo }) => ({ id, creator_display_name, creator_profile_photo }),
                ),
            ).toEqual([
                { id: "c-mine", creator_display_name: null, creator_profile_photo: null },
                { id: "c-theirs", creator_display_name: "Ada", creator_profile_photo: "data:image/png;base64,AAAA" },
                { id: "c-shared", creator_display_name: "Ada", creator_profile_photo: "data:image/png;base64,AAAA" },
            ]);
        });

        it("never demotes a project admin on a colleague's chat", async () => {
            seedChats();
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "admin",
                projectRole: "owner",
                project: { id: "p1", user_id: "u2", org_id: "org-1" },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            expect(
                (res.body as { access_role: string }[]).map((c) => c.access_role),
            ).toEqual(["owner", "owner", "owner"]);
        });

        it("labels every chat viewer when the caller only views the project", async () => {
            seedChats();
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole: "viewer",
                project: { id: "p1", user_id: "u2", org_id: null },
            });

            const res = await request(app)
                .get("/projects/p1/chats")
                .set(...AUTH);

            // Child rows inherit the project role; child grants are ignored.
            expect(
                (res.body as { access_role: string }[]).map((c) => c.access_role),
            ).toEqual(["viewer", "viewer", "viewer"]);
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

    // ── PATCH /projects/:projectId ───────────────────────────────────────
    describe("PATCH /projects/:projectId", () => {
        it("rejects the retired shared_with input", async () => {
            const res = await request(app)
                .patch("/projects/p1")
                .set(...AUTH)
                .send({ shared_with: ["u1@test.local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "shared_with is no longer supported; use the project access endpoints.",
            );
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
    // Pins the `container.delete` row of the matrix on the project container:
    // owner tier deletes, everything below it is refused with a 403 (a
    // stranger, who fails the access check outright, still gets 404).
    describe("DELETE /projects/:projectId", () => {
        it("returns 404 when nothing was deleted", async () => {
            deleteProjectsByIds.mockResolvedValue(0);

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 204 when an org Admin deletes another creator's project", async () => {
            deleteProjectsByIds.mockResolvedValue(1);
            checkProjectAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: "admin",
                projectRole: "owner",
                project: { id: "p1", user_id: "u2", org_id: "org-1" },
            });

      const res = await request(app)
        .delete("/projects/p1")
        .set(...AUTH);

            expect(res.status).toBe(204);
            // Deleted by id, with no owner filter: the capability check is
            // what authorised this, and an organization project may have no
            // creator left to scope by.
      expect(deleteProjectsByIds).toHaveBeenCalledWith(expect.anything(), [
        "p1",
      ]);
        });

        it.each(["member", "viewer"] as const)(
            "returns 403 when a %s tries to delete the project",
            async (projectRole) => {
                checkProjectAccess.mockResolvedValue({
                    ok: true,
                    isCreator: false,
                    orgRole: null,
                    projectRole,
                    project: { id: "p1", user_id: "owner", org_id: null },
                });

                const res = await request(app)
                    .delete("/projects/p1")
                    .set(...AUTH);

                expect(res.status).toBe(403);
                expect(res.body.detail).toBe(
                    "Only a project owner can delete this project.",
                );
                // Refused before the cascade could run.
                expect(deleteProjectsByIds).not.toHaveBeenCalled();
            },
        );

        it("returns 404 when the caller has no access at all", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .delete("/projects/p1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
            expect(deleteProjectsByIds).not.toHaveBeenCalled();
        });

        it("returns 500 when deletion throws", async () => {
            deleteProjectsByIds.mockRejectedValue(new Error("cascade failed"));

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
