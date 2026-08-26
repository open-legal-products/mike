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
const { checkProjectAccess, deleteUserProjects } = vi.hoisted(() => ({
    checkProjectAccess: vi.fn(),
    deleteUserProjects: vi.fn(),
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

vi.mock("../../lib/access", () => ({
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
}));

vi.mock("../../lib/userDataCleanup", () => ({
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
import { createServerSupabase } from "../../lib/supabase";
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
        return db as unknown as ReturnType<typeof createServerSupabase>;
    });
    return captured;
}

describe("workflows.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        resetEnsuredDefaultUsersForTests();
    });

    // ── GET /workflows (overview) ─────────────────────────────────────────
    describe("GET /workflows", () => {
        it("returns the user's installed workflows when no pagination params are present", async () => {
            supabaseState.rpc = {
                data: [{ id: "w1", title: "My workflow" }],
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
                metadata: { title: "My workflow" },
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
                return db as unknown as ReturnType<typeof createServerSupabase>;
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
});
