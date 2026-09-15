import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import {
    supabaseState,
    resetSupabaseState,
    mockSupabase,
} from "../helpers/supabaseMock";

// ---------------------------------------------------------------------------
// Hoisted mock fns we want to reconfigure per-test.
// ---------------------------------------------------------------------------
const { checkProjectAccess, checkWorkflowAccess, deleteUserProjects, getOrgRole } = vi.hoisted(
    () => ({
        checkProjectAccess: vi.fn(),
        checkWorkflowAccess: vi.fn(),
        deleteUserProjects: vi.fn(),
        getOrgRole: vi.fn(),
    }),
);

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

vi.mock("../../lib/access", () => ({
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    checkWorkflowAccess: (...args: unknown[]) => checkWorkflowAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isCreator: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isCreator: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: (...args: unknown[]) => getOrgRole(...args),
}));

vi.mock("../../modules/user/user.dataCleanup", () => ({
    deleteUserProjects: (...args: unknown[]) => deleteUserProjects(...args),
    deleteAllUserChats: vi.fn(async () => {}),
    deleteAllUserTabularReviews: vi.fn(async () => {}),
    deleteUserAccountData: vi.fn(async () => {}),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import { createServerSupabase, type Db } from "../../lib/supabase";
import { resetEnsuredDefaultUsersForTests } from "../../lib/workflowCatalog";

const AUTH = ["Authorization", "Bearer test"] as const;

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

describe("workflows.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        resetEnsuredDefaultUsersForTests();
        // Default: the caller belongs to no organization.
        getOrgRole.mockResolvedValue(null);
        checkWorkflowAccess.mockImplementation(
            async (_workflowId: string, userId: string) => {
                const workflow = supabaseState.tables.workflows?.data as
                    | { id: string; user_id: string | null; org_id?: string | null }
                    | null
                    | undefined;
                if (!workflow) return { ok: false };
                const isCreator = workflow.user_id === userId;
                if (isCreator)
                    return {
                        ok: true,
                        isCreator: true,
                        orgRole: null,
                        projectRole: "owner",
                        workflow,
                    };
                if (!workflow.org_id) return { ok: false };
                const orgRole = await getOrgRole(userId, workflow.org_id);
                if (!orgRole) return { ok: false };
                return {
                    ok: true,
                    isCreator: false,
                    orgRole,
                    projectRole: orgRole === "admin" ? "owner" : "editor",
                    workflow,
                };
            },
        );
    });

    // ── GET /workflows (overview) ─────────────────────────────────────────
    describe("GET /workflows", () => {
        it("returns the user's installed workflows when no pagination params are present", async () => {
            supabaseState.rpc = {
                data: [
                    {
                        id: "w1",
                        title: "My workflow",
                        org_id: "org-1",
                        access_scope: "organization",
                        organization_name: "Elite Law LLP",
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .get("/workflows?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            // Defaults are installed as user-owned database workflows rather
            // than prepended from the static system catalog.
            expect(res.body.at(-1)).toMatchObject({
                id: "w1",
                is_system: false,
                org_id: "org-1",
                access_scope: "organization",
                organization_name: "Elite Law LLP",
                metadata: { title: "My workflow" },
            });
        });

        it("backfills organization access when the overview RPC is stale", async () => {
            supabaseState.rpc = {
                data: [{ id: "w1", title: "Firm workflow", is_owner: true }],
                error: null,
            };
            supabaseState.tables.workflows = {
                data: [{ id: "w1", org_id: "org-1" }],
                error: null,
            };
            supabaseState.tables.workflow_shares = {
                data: [],
                error: null,
            };
            supabaseState.tables.organizations = {
                data: [{ id: "org-1", name: "Elite Law LLP" }],
                error: null,
            };

            const res = await request(app)
                .get("/workflows?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.at(-1)).toMatchObject({
                id: "w1",
                org_id: "org-1",
                access_scope: "organization",
                organization_name: "Elite Law LLP",
            });
        });

        // Regression guard: the workflow picker modal, the chat slash-menu
        // picker, and UseWorkflowModal's own independent fetch all call
        // GET /workflows with no pagination params and need the exact
        // legacy response shape (system workflows included) back. If this
        // ever silently switched to the paginated RPC shape by default,
        // those callers would start seeing a truncated, system-workflow-free
        // list with no error.
        it("calls the legacy 3-arg RPC shape when no pagination params are present", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

      await request(app)
        .get("/workflows?type=tabular")
        .set(...AUTH);

            expect(captured.name).toBe("get_workflows_overview");
            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_type: "tabular",
            });
        });

        it("calls the paginated RPC shape with every filter parsed once any pagination param is present, and omits system workflows", async () => {
            const captured = captureRpcArgs();
            supabaseState.rpc = { data: [], error: null };

            const res = await request(app)
                .get(
                    "/workflows?limit=10&scope=owned&sort_key=name&sort_direction=asc" +
                        "&search=nda&practice=Litigation&language=English&jurisdiction=NSW",
                )
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
            expect(captured.name).toBe("get_workflows_overview");
            expect(captured.args).toEqual({
                p_user_id: "u1",
                p_user_email: "u1@test.local",
                p_type: null,
                p_scope: "owned",
                p_limit: 10,
                p_offset: 0,
                p_search_term: "nda",
                p_sort_key: "name",
                p_sort_direction: "asc",
                p_practice: "Litigation",
                p_language: "English",
                p_jurisdiction: "NSW",
            });
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/workflows?type=assistant")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── GET /workflows/system ──────────────────────────────────────────────
    describe("GET /workflows/system", () => {
        it("returns catalog workflows in the legacy system response shape", async () => {
            supabaseState.tables.mike_workflows = {
                data: [
                    {
                        id: "catalog-1",
                        workflow_key: "proofread",
                        distribution: "default",
                        version: "1.0.0",
                        title: "Proofread",
                        description: "Proofread a document.",
                        type: "assistant",
                        prompt_md: "# Proofread",
                        columns_config: null,
                        contributors: [],
                        language: "English",
                        practice: "General Transactions",
                        jurisdictions: ["General"],
                        pack_key: null,
                        pack_title: null,
                        pack_description: null,
                        pack_version: null,
                        source_commit: "a".repeat(40),
                        content_hash: "b".repeat(64),
                        active: true,
                        created_at: "2026-08-23T00:00:00.000Z",
                        updated_at: "2026-08-23T00:00:00.000Z",
                    },
                ],
                error: null,
            };
            const res = await request(app)
                .get("/workflows/system?type=assistant")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([
                expect.objectContaining({
                    id: "builtin-proofread",
                    is_system: true,
                    metadata: expect.objectContaining({
                        type: "assistant",
                        title: "Proofread",
                    }),
                }),
            ]);
            expect(createServerSupabase).toHaveBeenCalled();
        });
    });

    // ── GET /workflows/ids (select-all-matching support) ──────────────────
    describe("GET /workflows/ids", () => {
        it("pages through the RPC until an empty page is returned", async () => {
            const rpcMock = vi
                .fn()
                .mockResolvedValueOnce({ data: 0, error: null })
                .mockResolvedValueOnce({
                    data: [{ id: "w1", user_id: "u1" }],
                    error: null,
                })
                .mockResolvedValueOnce({ data: [], error: null });
            vi.mocked(createServerSupabase).mockImplementationOnce(() => {
                const db = mockSupabase();
                db.rpc = rpcMock;
                return db as unknown as Db;
            });

      const res = await request(app)
        .get("/workflows/ids")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "w1", user_id: "u1" }]);
            expect(rpcMock).toHaveBeenCalledTimes(3);
            expect(rpcMock.mock.calls[0][0]).toBe(
                "install_missing_default_workflows",
            );
            expect(rpcMock.mock.calls[1][0]).toBe("get_workflow_ids_overview");
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/workflows/ids")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

  describe("GET /workflows/filter-options", () => {
    it("passes type and scope to the facet RPC", async () => {
      const captured = captureRpcArgs();
      supabaseState.rpc = {
        data: [
          {
            practices: ["Disputes"],
            languages: ["English"],
            jurisdictions: ["Singapore"],
          },
        ],
        error: null,
      };

      const res = await request(app)
        .get("/workflows/filter-options?type=assistant&scope=shared")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        practices: ["Disputes"],
        languages: ["English"],
        jurisdictions: ["Singapore"],
      });
      expect(captured.name).toBe("get_workflow_filter_options");
      expect(captured.args).toEqual({
        p_user_id: "u1",
        p_user_email: "u1@test.local",
        p_type: "assistant",
        p_scope: "shared",
      });
    });
  });

  describe("POST /workflows/:workflowId/assets/from-documents", () => {
    it("rejects an empty saved-file selection", async () => {
      const res = await request(app)
        .post("/workflows/workflow-1/assets/from-documents")
        .set(...AUTH)
        .send({ document_ids: [] });

      expect(res.status).toBe(400);
      expect(res.body.detail).toContain("between 1 and 50");
      expect(createServerSupabase).not.toHaveBeenCalled();
    });

    it("does not allow assets on a tabular workflow", async () => {
      supabaseState.tables.workflows = {
        data: {
          id: "workflow-1",
          user_id: "u1",
          type: "tabular",
        },
        error: null,
      };

      const res = await request(app)
        .post("/workflows/workflow-1/assets/from-documents")
        .set(...AUTH)
        .send({ document_ids: ["document-1"] });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        detail: "Assets are only available for assistant workflows",
      });
    });
  });

  // ── Organization workflows ────────────────────────────────────────────
  // Before this, org workflows were write-dead: POST hardcoded org_id null so
  // no API call could create one, and the org arm of the list RPC reported
  // allow_edit false so even an org admin could not change one that already
  // existed. The only way to get an org workflow at all was the account
  // -deletion detach path — a firm's shared workflow that nobody could make
  // and nobody could edit.
  describe("organization workflows", () => {
    const create = (body: Record<string, unknown>) =>
      request(app)
        .post("/workflows")
        .set(...AUTH)
        .send({
          metadata: { title: "Firm playbook", type: "assistant" },
          ...body,
        });

    it("files a workflow under an organization the caller belongs to", async () => {
      getOrgRole.mockResolvedValue("member");
      supabaseState.tables.workflows = {
        data: { id: "w-org", user_id: "u1", org_id: "org-1" },
        error: null,
      };

      const res = await create({ org_id: "org-1" });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        org_id: "org-1",
        access_scope: "organization",
        organization_name: null,
      });
      expect(
        supabaseState.inserts.find((i) => i.table === "workflows")?.payload,
      ).toMatchObject({ org_id: "org-1", user_id: "u1" });
    });

    it("400s an org the caller does not belong to, and writes nothing", async () => {
      getOrgRole.mockResolvedValue(null);

      const res = await create({ org_id: "org-elsewhere" });

      expect(res.status).toBe(400);
      expect(res.body.detail).toBe(
        "You are not a member of that organization.",
      );
      expect(supabaseState.inserts).toEqual([]);
    });

    it("keeps a workflow personal when no org is named", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w1", user_id: "u1", org_id: null },
        error: null,
      };

      const res = await create({});

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        org_id: null,
        access_scope: "private",
        organization_name: null,
      });
      expect(
        supabaseState.inserts.find((i) => i.table === "workflows")?.payload,
      ).toMatchObject({ org_id: null });
    });

    it("lets a colleague in the same org edit an org workflow", async () => {
      // The workflow belongs to the organization, not to whoever drafted it.
      // Both org roles sit at member or above on the ladder, where editing
      // content is a member capability.
      supabaseState.tables.workflows = {
        data: {
          id: "w-org",
          user_id: "someone-else",
          org_id: "org-1",
          title: "Firm playbook",
        },
        error: null,
      };
      supabaseState.tables.workflow_shares = { data: null, error: null };
      getOrgRole.mockResolvedValue("member");

      const res = await request(app)
        .patch("/workflows/w-org")
        .set(...AUTH)
        .send({ metadata: { title: "Firm playbook v2" } });

      expect(res.status).toBe(200);
      // Editable, but not owned: share and delete stay with the creator.
      expect(res.body.allow_edit).toBe(true);
      expect(res.body.is_owner).toBe(false);
    });

    it("still refuses an org workflow to somebody outside the org", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-org", user_id: "someone-else", org_id: "org-1" },
        error: null,
      };
      supabaseState.tables.workflow_shares = { data: null, error: null };
      getOrgRole.mockResolvedValue(null);

      const res = await request(app)
        .patch("/workflows/w-org")
        .set(...AUTH)
        .send({ metadata: { title: "Nope" } });

      expect(res.status).toBe(404);
    });
  });

  describe("workflow direct grants", () => {
    it("rejects a personal grant for an email that has not registered", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-personal", user_id: "u1", org_id: null },
        error: null,
      };
      supabaseState.tables.user_profiles = { data: [], error: null };

      const res = await request(app)
        .post("/workflows/w-personal/share")
        .set(...AUTH)
        .send({ emails: ["future@firm.test"], role: "viewer" });

      expect(res.status).toBe(400);
      expect(res.body.detail).toBe(
        "future@firm.test does not belong to a Mike user.",
      );
    });

    it("stores a personal grant for an existing user", async () => {
      supabaseState.tables.workflows = {
        data: { id: "w-personal", user_id: "u1", org_id: null },
        error: null,
      };
      supabaseState.tables.user_profiles = {
        data: [{ email: "colleague@firm.test" }],
        error: null,
      };
      supabaseState.tables.workflow_shares = { data: null, error: null };

      const res = await request(app)
        .post("/workflows/w-personal/share")
        .set(...AUTH)
        .send({ emails: ["colleague@firm.test"], role: "editor" });

      expect(res.status).toBe(204);
    });
  });

  describe("organization workflow Owner operations", () => {
    const detached = {
      id: "w-orphan",
      user_id: null,
      org_id: "org-1",
      title: "Orphaned firm playbook",
    };

    function captureWorkflowQueries() {
      const queries: { table: string; q: Record<string, unknown> }[] = [];
      vi.mocked(createServerSupabase).mockImplementationOnce(() => {
        const db = mockSupabase();
        const originalFrom = db.from;
        db.from = vi.fn((table: string) => {
          const q = originalFrom(table);
          queries.push({ table, q: q as Record<string, unknown> });
          return q;
        });
        return db as unknown as ReturnType<typeof createServerSupabase>;
      });
      return queries;
    }

    it("lets an org admin delete a workflow whose creator's account is gone", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      supabaseState.tables.workflow_reference_documents = {
        data: [],
        error: null,
      };
      getOrgRole.mockResolvedValue("admin");
      const queries = captureWorkflowQueries();

      const res = await request(app)
        .delete("/workflows/w-orphan")
        .set(...AUTH);

      expect(res.status).toBe(204);
      expect(getOrgRole).toHaveBeenCalledWith("u1", "org-1");
      // The delete must be keyed by id alone: nothing can match a NULL
      // creator, so any user_id filter would turn this into a silent no-op.
      for (const { table, q } of queries) {
        if (table !== "workflows") continue;
        const eq = q.eq as ReturnType<typeof vi.fn>;
        const columns = eq.mock.calls.map((c) => c[0]);
        expect(columns).not.toContain("user_id");
      }
    });

    it("does not extend Owner operations to org Members", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      getOrgRole.mockResolvedValue("member");

      const res = await request(app)
        .delete("/workflows/w-orphan")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });

    it("lets an org Admin manage a workflow with a living creator", async () => {
      supabaseState.tables.workflows = {
        data: { ...detached, user_id: "someone-else" },
        error: null,
      };
      getOrgRole.mockResolvedValue("admin");

      const res = await request(app)
        .delete("/workflows/w-orphan")
        .set(...AUTH);

      expect(res.status).toBe(204);
    });

    it("applies the same Owner rule to the sharing surface", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      supabaseState.tables.workflow_shares = { data: [], error: null };
      getOrgRole.mockResolvedValue("admin");

      const res = await request(app)
        .get("/workflows/w-orphan/shares")
        .set(...AUTH);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("keeps the sharing surface closed to org members", async () => {
      supabaseState.tables.workflows = { data: detached, error: null };
      getOrgRole.mockResolvedValue("member");

      const res = await request(app)
        .get("/workflows/w-orphan/shares")
        .set(...AUTH);

      expect(res.status).toBe(404);
    });
  });
});
