import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { supabaseState, resetSupabaseState } from "../helpers/supabaseMock";

// ---------------------------------------------------------------------------
// Hoisted mock fns reconfigured per-test. Access helpers + model settings are
// mocked so the tests drive review-access decisions, document-access filtering
// and the missing-API-key guard without touching real Supabase / LLM IO. The
// streaming endpoints (chat/generate) are only exercised up to their GUARDS —
// the SSE loop itself is never reached in these tests.
// ---------------------------------------------------------------------------
const {
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
    getUserModelSettings,
} = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    checkProjectAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    getUserModelSettings: vi.fn(),
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
    ensureReviewAccess: (...args: unknown[]) => ensureReviewAccess(...args),
    checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
    filterAccessibleDocumentIds: (...args: unknown[]) =>
        filterAccessibleDocumentIds(...args),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    listAccessibleProjectIds: vi.fn(async () => []),
}));

vi.mock("../../lib/userSettings", () => ({
    getUserModelSettings: (...args: unknown[]) => getUserModelSettings(...args),
    getUserApiKeys: vi.fn(async () => ({})),
}));

// Version-path enrichment hits the DB in real life; no-op it so route
// responses are driven purely by the table stubs.
vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;

describe("tabular.routes", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        // Default: caller is the owner with full access.
        ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: true });
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isOwner: true,
            project: { id: "p1", user_id: "u1", shared_with: null },
        });
        // Default: every requested doc is accessible (identity passthrough).
        filterAccessibleDocumentIds.mockImplementation(
            async (ids: string[]) => ids,
        );
        getUserModelSettings.mockResolvedValue({
            title_model: "claude-haiku-4-5",
            tabular_model: "claude-sonnet-4-5",
            legal_research_us: false,
            api_keys: { claude: "sk-test" },
        });
    });

    // ── GET /tabular-review (overview) ────────────────────────────────────
    describe("GET /tabular-review", () => {
        it("returns the overview rows from the RPC", async () => {
            supabaseState.rpc = {
                data: [{ id: "r1", title: "Alpha" }],
                error: null,
            };

      const res = await request(app)
        .get("/tabular-review")
        .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([{ id: "r1", title: "Alpha" }]);
        });

        it("returns 500 with detail when the RPC errors", async () => {
            supabaseState.rpc = { data: null, error: { message: "boom" } };

      const res = await request(app)
        .get("/tabular-review")
        .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── POST /tabular-review (create) ─────────────────────────────────────
    describe("POST /tabular-review", () => {
        it("creates a review (201) and only persists accessible documents", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r9", title: "Gamma", document_ids: ["d1"] },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        filename: "Agreement.pdf",
                        file_type: "pdf",
                        folder_id: null,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-1",
                        review_id: "r9",
                        label: "Agreement.pdf",
                        row_type: "document",
                        folder_id: null,
                        document_id: "d1",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            // d2 is not accessible — it must be filtered out of the insert.
            filterAccessibleDocumentIds.mockResolvedValue(["d1"]);

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Gamma",
                    document_ids: ["d1", "d2"],
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                });

            expect(res.status).toBe(201);
            expect(res.body).toMatchObject({ id: "r9" });

            const reviewInsert = supabaseState.inserts.find(
                (i) => i.table === "tabular_reviews",
            );
            expect(reviewInsert?.payload).toMatchObject({
                document_ids: ["d1"],
            });
            // Cells are created for accessible review rows × columns only (1 × 1).
            const cellInsert = supabaseState.inserts.find(
                (i) => i.table === "tabular_cells",
            );
            expect(cellInsert?.payload).toEqual([
                {
                    review_id: "r9",
                    row_id: "row-1",
                    document_id: "d1",
                    column_index: 0,
                    status: "pending",
                },
            ]);
        });

        it("groups project-folder documents into one review row", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r10", title: "Grouped", document_ids: ["d1", "d2", "d3"] },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
          {
            id: "d1",
            filename: "A.pdf",
            file_type: "pdf",
            project_id: "p1",
            folder_id: "f1",
          },
          {
            id: "d2",
            filename: "B.pdf",
            file_type: "pdf",
            project_id: "p1",
            folder_id: "f1",
          },
          {
            id: "d3",
            filename: "Loose.pdf",
            file_type: "pdf",
            project_id: "p1",
            folder_id: null,
          },
                ],
                error: null,
            };
            supabaseState.tables.project_subfolders = {
                data: [{ id: "f1", name: "Contracts", parent_folder_id: null }],
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-folder",
                        review_id: "r10",
                        label: "Contracts",
                        row_type: "folder",
                        folder_id: "f1",
                        library_folder_id: null,
                        document_id: null,
                        sort_index: 0,
                    },
                    {
                        id: "row-document",
                        review_id: "r10",
                        label: "Loose.pdf",
                        row_type: "document",
                        folder_id: null,
                        library_folder_id: null,
                        document_id: "d3",
                        sort_index: 1,
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Grouped",
                    project_id: "p1",
                    document_ids: ["d1", "d2", "d3"],
                    document_grouping: "folder",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                });

            expect(res.status).toBe(201);
      expect(
        supabaseState.inserts.find((i) => i.table === "tabular_reviews")
          ?.payload,
      ).toMatchObject({ document_grouping: "folder" });
      expect(
        supabaseState.inserts.find((i) => i.table === "tabular_review_rows")
          ?.payload,
      ).toEqual([
                    {
                        review_id: "r10",
                        label: "Contracts",
                        row_type: "folder",
                        folder_id: "f1",
                        library_folder_id: null,
                        document_id: null,
                        sort_index: 0,
                    },
                    {
                        review_id: "r10",
                        label: "Loose.pdf",
                        row_type: "document",
                        folder_id: null,
                        library_folder_id: null,
                        document_id: "d3",
                        sort_index: 1,
                    },
                ]);
      expect(
        supabaseState.inserts.find(
          (i) => i.table === "tabular_review_row_sources",
        )?.payload,
      ).toEqual([
                    { row_id: "row-folder", document_id: "d1", sort_index: 0 },
                    { row_id: "row-folder", document_id: "d2", sort_index: 1 },
                    { row_id: "row-document", document_id: "d3", sort_index: 0 },
                ]);
      expect(
        supabaseState.inserts.find((i) => i.table === "tabular_cells")?.payload,
      ).toEqual([
                    {
                        review_id: "r10",
                        row_id: "row-folder",
                        document_id: null,
                        column_index: 0,
                        status: "pending",
                    },
                    {
                        review_id: "r10",
                        row_id: "row-document",
                        document_id: "d3",
                        column_index: 0,
                        status: "pending",
                    },
                ]);
        });

        it("groups library file-folder documents into one review row", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r11", title: "Library grouped" },
                error: null,
            };
            supabaseState.tables.documents = {
                data: [
                    {
                        id: "d1",
                        filename: "A.pdf",
                        file_type: "pdf",
                        project_id: null,
                        folder_id: null,
                        library_folder_id: "lf1",
                    },
                    {
                        id: "d2",
                        filename: "B.pdf",
                        file_type: "pdf",
                        project_id: null,
                        folder_id: null,
                        library_folder_id: "lf1",
                    },
                ],
                error: null,
            };
            supabaseState.tables.library_folders = {
                data: [
                    {
                        id: "lf1",
                        name: "Precedents",
                        parent_folder_id: null,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-library-folder",
                        review_id: "r11",
                        label: "Precedents",
                        row_type: "folder",
                        folder_id: null,
                        library_folder_id: "lf1",
                        document_id: null,
                        sort_index: 0,
                    },
                ],
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    title: "Library grouped",
                    document_ids: ["d1", "d2"],
                    document_grouping: "folder",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                });

            expect(res.status).toBe(201);
            expect(
                supabaseState.inserts.find(
                    (insert) => insert.table === "tabular_review_rows",
                )?.payload,
            ).toEqual([
                {
                    review_id: "r11",
                    label: "Precedents",
                    row_type: "folder",
                    folder_id: null,
                    library_folder_id: "lf1",
                    document_id: null,
                    sort_index: 0,
                },
            ]);
            expect(
                supabaseState.inserts.find(
                    (insert) => insert.table === "tabular_review_row_sources",
                )?.payload,
            ).toEqual([
                {
                    row_id: "row-library-folder",
                    document_id: "d1",
                    sort_index: 0,
                },
                {
                    row_id: "row-library-folder",
                    document_id: "d2",
                    sort_index: 1,
                },
            ]);
        });

        it("returns 404 when project access is denied", async () => {
            checkProjectAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({
                    project_id: "p-nope",
                    document_ids: [],
                    columns_config: [],
                });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Project not found");
        });

        it("returns 500 when the review insert errors", async () => {
            supabaseState.tables.tabular_reviews = {
                data: null,
                error: { message: "insert failed" },
            };

            const res = await request(app)
                .post("/tabular-review")
                .set(...AUTH)
                .send({ document_ids: [], columns_config: [] });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── GET /tabular-review/:reviewId (detail) ────────────────────────────
    describe("GET /tabular-review/:reviewId", () => {
        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(app)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 200 with review/cells/documents + is_owner", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    document_ids: ["d1"],
                    columns_config: [],
                    active_generation_id: "generation-1",
                    generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = {
                data: [
                    {
                        id: "c1",
                        document_id: "d1",
                        column_index: 0,
                        content: null,
                        status: "pending",
                    },
                ],
                error: null,
            };
            supabaseState.tables.documents = {
                data: [{ id: "d1", current_version_id: null }],
                error: null,
            };

            const res = await request(app)
                .get("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(200);
            expect(res.body.review).toMatchObject({
                id: "r1",
                is_owner: true,
                is_running: true,
            });
            expect(res.body.cells).toHaveLength(1);
            expect(res.body.documents).toEqual([
                { id: "d1", current_version_id: null },
            ]);
        });
    });

    // ── PATCH /tabular-review/:reviewId ───────────────────────────────────
    describe("PATCH /tabular-review/:reviewId", () => {
        it("returns 400 when project_id is an invalid type", async () => {
            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ project_id: 123 });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "project_id must be a non-empty string or null",
            );
        });

        it("returns 400 when sharing the review with yourself", async () => {
            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ shared_with: ["U1@Test.Local"] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "You cannot share a tabular review with yourself.",
            );
        });

        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ title: "Renamed" });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 403 when a non-owner edits columns_config", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: "p1" },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: false });

            const res = await request(app)
                .patch("/tabular-review/r1")
                .set(...AUTH)
                .send({ columns_config: [{ index: 0, name: "X", prompt: "p" }] });

            expect(res.status).toBe(403);
            expect(res.body.detail).toBe("Only the review owner can change columns");
        });
    });

    // ── DELETE /tabular-review/:reviewId ──────────────────────────────────
    describe("DELETE /tabular-review/:reviewId", () => {
        it("returns 204 on success", async () => {
            // The route now selects the deleted ids back, so the fixture has
            // to report the row it removed.
            supabaseState.tables.tabular_reviews = {
                data: [{ id: "r1" }],
                error: null,
            };

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(204);
        });

        it("returns 404 when the delete matches no review", async () => {
            // A collaborator deleting a review they do not own matches nothing;
            // answering 204 told the UI a no-op had succeeded.
            supabaseState.tables.tabular_reviews = { data: [], error: null };

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 500 when the delete errors", async () => {
            supabaseState.tables.tabular_reviews = {
                data: null,
                error: { message: "delete failed" },
            };

            const res = await request(app)
                .delete("/tabular-review/r1")
                .set(...AUTH);

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe("Something went wrong. Please try again.");
        });
    });

    // ── POST /tabular-review/:reviewId/clear-cells ────────────────────────
    describe("POST /tabular-review/:reviewId/clear-cells", () => {
        it("returns 400 when row_ids is missing", async () => {
            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("row_ids is required");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("rejects clearing cells while generation holds the review lease", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    active_generation_id: "00000000-0000-4000-8000-000000000001",
                    generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(409);
            expect(res.body).toEqual({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
            expect(supabaseState.operations).not.toContain("from:tabular_cells");
        });

        it("atomically rejects clearing when a run starts after the review read", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                },
                error: null,
            };
            supabaseState.rpc = { data: "running", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe("review_running");
            expect(supabaseState.rpcCalls[0]?.fn).toBe(
                "begin_tabular_review_generation",
            );
            expect(supabaseState.operations).not.toContain("from:tabular_cells");
        });

        it("returns 204 on success", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                },
                error: null,
            };
            supabaseState.rpc = { data: "started", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/clear-cells")
                .set(...AUTH)
                .send({ row_ids: ["row-1"] });

            expect(res.status).toBe(204);
            expect(supabaseState.rpcCalls.map(({ fn }) => fn)).toEqual([
                "begin_tabular_review_generation",
                "finish_tabular_review_generation",
            ]);
        });
    });

    // ── POST /tabular-review/:reviewId/regenerate-cell ────────────────────
    describe("POST /tabular-review/:reviewId/regenerate-cell", () => {
        it("returns 400 when row_id / column_index are missing", async () => {
            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
      expect(res.body.detail).toBe("row_id and column_index are required");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("rejects cell regeneration while generation holds the review lease", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    active_generation_id: "00000000-0000-4000-8000-000000000001",
                    generation_lease_expires_at: "2099-01-01T00:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(409);
            expect(res.body).toEqual({
                code: "review_running",
                detail: "This tabular review is currently running.",
            });
            expect(supabaseState.operations).not.toContain(
                "from:tabular_review_rows",
            );
        });

        it("atomically rejects regeneration when a run starts after the review read", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-1",
                        review_id: "r1",
                        label: "Document",
                        row_type: "document",
                        document_id: "d1",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_row_sources = {
                data: [{ row_id: "row-1", document_id: "d1" }],
                error: null,
            };
            supabaseState.rpc = { data: "running", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe("review_running");
            expect(supabaseState.rpcCalls[0]?.fn).toBe(
                "begin_tabular_review_generation",
            );
            expect(supabaseState.operations).not.toContain("from:tabular_cells");
        });

        it("returns 400 when the column is not configured", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 5, name: "Other", prompt: "p" }],
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("Column not found");
        });

        it("returns 404 when a row source document is not accessible", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-forbidden",
                        review_id: "r1",
                        label: "Forbidden",
                        row_type: "document",
                        document_id: "d-forbidden",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_row_sources = {
                data: [
                    {
                        row_id: "row-forbidden",
                        document_id: "d-forbidden",
                    },
                ],
                error: null,
            };
            filterAccessibleDocumentIds.mockResolvedValue([]);

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-forbidden", column_index: 0 });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review row not found");
        });

        it("returns 422 with missing_api_key when the model key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [
                    {
                        id: "row-1",
                        review_id: "r1",
                        label: "Document",
                        row_type: "document",
                        document_id: "d1",
                        sort_index: 0,
                    },
                ],
                error: null,
            };
            supabaseState.tables.tabular_review_row_sources = {
                data: [{ row_id: "row-1", document_id: "d1" }],
                error: null,
            };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-4-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(app)
                .post("/tabular-review/r1/regenerate-cell")
                .set(...AUTH)
                .send({ row_id: "row-1", column_index: 0 });

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
            expect(res.body.provider).toBe("claude");
        });
    });

    // ── POST /tabular-review/:reviewId/generate (streaming GUARDS only) ───
    describe("POST /tabular-review/:reviewId/generate", () => {
        it("returns 404 when the review does not exist", async () => {
            supabaseState.tables.tabular_reviews = { data: null, error: null };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 400 when no columns are configured", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [],
                },
                error: null,
            };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("No columns configured");
        });

        it("returns 422 missing_api_key before streaming when the key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-4-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH);

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
        });

        it("requires the version currently loaded by the client", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe(
                "expected_updated_at must be a valid timestamp",
            );
        });

        it("claims the lease before loading rows and cells", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    updated_at: "2026-08-22T10:00:00.000Z",
                    columns_config: [{ index: 0, name: "Col", prompt: "p" }],
                },
                error: null,
            };
            supabaseState.tables.tabular_review_rows = {
                data: [],
                error: null,
            };
            supabaseState.tables.tabular_cells = {
                data: null,
                error: { message: "cell snapshot failed" },
            };
            supabaseState.rpc = { data: "started", error: null };

            const res = await request(app)
                .post("/tabular-review/r1/generate")
                .set(...AUTH)
                .send({
                    expected_updated_at: "2026-08-22T10:00:00.000Z",
                });

            expect(res.status).toBe(500);
            expect(res.body.detail).toBe(
                "Something went wrong. Please try again.",
            );
            const beginIndex = supabaseState.operations.indexOf(
                "rpc:begin_tabular_review_generation",
            );
            const rowsIndex = supabaseState.operations.indexOf(
                "from:tabular_review_rows",
            );
            const cellsIndex = supabaseState.operations.indexOf(
                "from:tabular_cells",
            );
            expect(beginIndex).toBeGreaterThanOrEqual(0);
            expect(rowsIndex).toBeGreaterThan(beginIndex);
            expect(cellsIndex).toBeGreaterThan(rowsIndex);
            expect(supabaseState.rpcCalls.at(-1)?.fn).toBe(
                "finish_tabular_review_generation",
            );
        });

        it.each([
            [
                "running",
                "review_running",
                "This tabular review is already running elsewhere.",
            ],
            [
                "stale",
                "review_stale",
                "A newer version of this tabular review is available.",
            ],
        ])(
            "returns a distinct conflict when the atomic start result is %s",
            async (startResult, code, detail) => {
                supabaseState.tables.tabular_reviews = {
                    data: {
                        id: "r1",
                        user_id: "u1",
                        project_id: null,
                        updated_at: "2026-08-22T10:00:00.000Z",
                        columns_config: [
                            { index: 0, name: "Col", prompt: "p" },
                        ],
                    },
                    error: null,
                };
                supabaseState.tables.tabular_cells = {
                    data: [],
                    error: null,
                };
                supabaseState.rpc = { data: startResult, error: null };

                const res = await request(app)
                    .post("/tabular-review/r1/generate")
                    .set(...AUTH)
                    .send({
                        expected_updated_at: "2026-08-22T10:00:00.000Z",
                    });

                expect(res.status).toBe(409);
                expect(res.body).toEqual({ code, detail });
                expect(supabaseState.rpcCalls[0]).toMatchObject({
                    fn: "begin_tabular_review_generation",
                    args: {
                        target_review_id: "r1",
                        expected_updated_at: "2026-08-22T10:00:00.000Z",
                    },
                });
            },
        );
    });

    // ── POST /tabular-review/:reviewId/chat (streaming GUARDS only) ───────
    describe("POST /tabular-review/:reviewId/chat", () => {
        it("returns 400 when no user message is present", async () => {
            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({ messages: [{ role: "assistant", content: "hi" }] });

            expect(res.status).toBe(400);
            expect(res.body.detail).toBe("messages must include a user message");
        });

        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({ messages: [{ role: "user", content: "hello" }] });

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns 422 missing_api_key before streaming when the key is absent", async () => {
            supabaseState.tables.tabular_reviews = {
                data: {
                    id: "r1",
                    user_id: "u1",
                    project_id: null,
                    columns_config: [],
                },
                error: null,
            };
            supabaseState.tables.tabular_cells = { data: [], error: null };
            getUserModelSettings.mockResolvedValue({
                title_model: "claude-haiku-4-5",
                tabular_model: "claude-sonnet-4-5",
                legal_research_us: false,
                api_keys: {},
            });

            const res = await request(app)
                .post("/tabular-review/r1/chat")
                .set(...AUTH)
                .send({ messages: [{ role: "user", content: "hello" }] });

            expect(res.status).toBe(422);
            expect(res.body.code).toBe("missing_api_key");
        });
    });

    // ── GET /tabular-review/:reviewId/chats ───────────────────────────────
    describe("GET /tabular-review/:reviewId/chats", () => {
        it("returns 404 when review access is denied", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "other", project_id: null },
                error: null,
            };
            ensureReviewAccess.mockResolvedValue({ ok: false });

            const res = await request(app)
                .get("/tabular-review/r1/chats")
                .set(...AUTH);

            expect(res.status).toBe(404);
            expect(res.body.detail).toBe("Review not found");
        });

        it("returns the chat list when access is granted", async () => {
            supabaseState.tables.tabular_reviews = {
                data: { id: "r1", user_id: "u1", project_id: null },
                error: null,
            };
            supabaseState.tables.tabular_review_chats = {
                data: [{ id: "chat-1", title: "T", user_id: "u1" }],
                error: null,
            };

            const res = await request(app)
                .get("/tabular-review/r1/chats")
                .set(...AUTH);

            expect(res.status).toBe(200);
      expect(res.body).toEqual([{ id: "chat-1", title: "T", user_id: "u1" }]);
        });
    });
});
