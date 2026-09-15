// Unit tests for the review-record services behind the /tabular-review CRUD
// endpoints. They exist to pin the branching the routes used to carry inline:
// who may change what, which failures are 403 vs 404 vs 400, and the two
// compensating actions (delete the review when its rows cannot be built, page
// the ids RPC until it runs dry).

import { describe, it, expect, vi, beforeEach } from "vitest";

const {
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
    resolveContentOrgId,
} = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    checkProjectAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    resolveContentOrgId: vi.fn(),
}));
// Partial: `can` and `creatorScopedAllowed` are pure policy and stay real —
// the per-field gates below are exactly what they decide — and the user
// facade's import graph reads other `lib/access` exports at import time.
vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
    resolveContentOrgId,
}));

const loadProfileUsersByEmail = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/userLookup", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/userLookup")>()),
    loadProfileUsersByEmail,
}));

const listContentPeople = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/resourcePeople", () => ({ listContentPeople }));

const { listContentGrants, upsertContentGrant, deleteContentGrant } =
    vi.hoisted(() => ({
        listContentGrants: vi.fn(),
        upsertContentGrant: vi.fn(),
        deleteContentGrant: vi.fn(),
    }));
vi.mock("../../../lib/contentAccess", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/contentAccess")>()),
    listContentGrants,
    upsertContentGrant,
    deleteContentGrant,
}));

vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn().mockResolvedValue(undefined),
}));

const { fetchSourceDocuments, loadReviewRows } = vi.hoisted(() => ({
    fetchSourceDocuments: vi.fn(),
    loadReviewRows: vi.fn(),
}));
vi.mock("../tabular.rows", () => ({ fetchSourceDocuments, loadReviewRows }));

const validateSelectedModel = vi.hoisted(() => vi.fn());
vi.mock("../tabular.shared", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.shared")>()),
    validateSelectedModel,
}));

import {
    createTabularReview,
    deleteTabularReview,
    getTabularReviewAccess,
    getTabularReviewDetail,
    getTabularReviewPeople,
    grantTabularReviewAccess,
    listTabularReviewIds,
    revokeTabularReviewAccess,
    updateTabularReview,
} from "../tabular.reviews";
import { callTo, makeFakeDb } from "./fakeDb";

const WHO = { userId: "user-1", userEmail: "me@example.com" };
/** The caller is the review's own creator, i.e. its owner. */
const OWNER = {
    ok: true,
    isCreator: true,
    orgRole: null,
    projectRole: "owner",
};

beforeEach(() => {
    vi.clearAllMocks();
    ensureReviewAccess.mockResolvedValue(OWNER);
    checkProjectAccess.mockResolvedValue({ ...OWNER, project: { id: "p1" } });
    filterAccessibleDocumentIds.mockResolvedValue([]);
    // Default: personal content — there is no tenant to inherit.
    resolveContentOrgId.mockResolvedValue({ ok: true, orgId: null });
    loadProfileUsersByEmail.mockResolvedValue({
        userByEmail: new Map(),
        userById: new Map(),
    });
    fetchSourceDocuments.mockResolvedValue([]);
    loadReviewRows.mockResolvedValue([]);
    validateSelectedModel.mockResolvedValue({
        ok: true,
        model: "claude-sonnet-5",
        apiKeys: {},
    });
});

describe("createTabularReview", () => {
    it("rejects a missing model before touching the database", async () => {
        const { db, calls } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result).toMatchObject({ kind: "status", status: 400 });
        expect(result.kind === "status" && result.body.code).toBe(
            "model_required",
        );
        expect(calls).toEqual([]);
    });

    it("carries a model-policy rejection through with its own status", async () => {
        validateSelectedModel.mockResolvedValue({
            ok: false,
            status: 422,
            body: { code: "missing_api_key" },
        });
        const { db } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "status",
            status: 422,
        });
    });

    it("404s when the target project is not reachable", async () => {
        checkProjectAccess.mockResolvedValue({ ok: false });
        const { db } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            project_id: "proj-1",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Project not found",
        });
    });

    it("deletes the review again when its rows cannot be built", async () => {
        // fetchSourceDocuments is what createRowsForReview calls first; making
        // it throw is the cheapest way to reach the compensating delete.
        fetchSourceDocuments.mockRejectedValue(new Error("rows exploded"));
        filterAccessibleDocumentIds.mockResolvedValue(["doc-1"]);
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: { data: { id: "rev-1" }, error: null },
            },
        });
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: ["doc-1"],
            columns_config: [],
            model: "claude-sonnet-5",
        });
        expect(result).toMatchObject({ ok: false, kind: "status", status: 500 });
        expect(result.ok === false && result.kind === "status" && result.body)
            .toEqual({ detail: "rows exploded" });
        expect(callTo(calls, "tabular_reviews", 1)).toMatchObject({
            op: "delete",
            filters: { id: "rev-1" },
        });
    });

    it("refuses a standalone organization scope", async () => {
        // A review's tenant is inherited from its project, never asked for:
        // an org-scoped standalone review would be visible to a whole
        // organization with no container to govern it.
        const { db, calls } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            org_id: "org-1",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Tabular reviews cannot be organization-scoped. Create the review inside an organization project instead.",
        });
        expect(calls.some((call) => call.op === "insert")).toBe(false);
    });

    it("refuses to guess the tenant when the lookup fails", async () => {
        resolveContentOrgId.mockResolvedValue({
            ok: false,
            detail: "connection reset",
        });
        const { db, calls } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            project_id: "proj-1",
        });
        expect(result).toMatchObject({ ok: false, kind: "error" });
        expect(calls.some((call) => call.op === "insert")).toBe(false);
    });

    it("404s a project the caller may read but not contribute to", async () => {
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "viewer",
            project: { id: "proj-1" },
        });
        const { db } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            project_id: "proj-1",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Project not found",
        });
    });

    it("stamps the project's tenant and answers as the creator", async () => {
        resolveContentOrgId.mockResolvedValue({ ok: true, orgId: "org-2" });
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: { id: "rev-1", title: "T" },
                    error: null,
                },
            },
        });
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            project_id: "proj-1",
        });
        expect(result).toEqual({
            ok: true,
            data: {
                id: "rev-1",
                title: "T",
                is_owner: true,
                access_role: "owner",
            },
        });
        expect(callTo(calls, "tabular_reviews")?.payload).toMatchObject({
            org_id: "org-2",
        });
    });
});

describe("getTabularReviewDetail", () => {
    it("404s an unreachable review rather than 403", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: false });
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: { id: "rev-1" }, error: null } },
        });
        const result = await getTabularReviewDetail(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
    });

    it("hides the lease columns and reports whether a run is live", async () => {
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: {
                        id: "rev-1",
                        document_ids: [],
                        active_generation_id: "gen-1",
                        generation_lease_expires_at: new Date(
                            Date.now() + 60_000,
                        ).toISOString(),
                    },
                    error: null,
                },
                tabular_cells: { data: [], error: null },
            },
        });
        const result = await getTabularReviewDetail(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.review).toMatchObject({
            is_owner: true,
            access_role: "owner",
            is_running: true,
        });
        expect(result.data.review).not.toHaveProperty("active_generation_id");
        expect(result.data.review).not.toHaveProperty(
            "generation_lease_expires_at",
        );
    });

    it("parses each cell's stored content", async () => {
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: { id: "rev-1", document_ids: [] },
                    error: null,
                },
                tabular_cells: {
                    data: [
                        {
                            id: "c1",
                            content: '{"summary":"yes","flag":"green"}',
                        },
                    ],
                    error: null,
                },
            },
        });
        const result = await getTabularReviewDetail(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result.ok && result.data.cells[0].content).toMatchObject({
            summary: "yes",
            flag: "green",
        });
    });
});

describe("getTabularReviewPeople", () => {
    const REVIEW_ROW = {
        id: "rev-1",
        user_id: "user-1",
        project_id: null,
        org_id: null,
    };

    it("hands the review row to the shared roster builder", async () => {
        // The roster itself (project inheritance vs direct grants) belongs to
        // lib/resourcePeople; what this service owns is the access gate and
        // passing the row through unchanged.
        const roster = {
            ok: true as const,
            scope: "direct" as const,
            owner: {
                user_id: "user-1",
                email: "me@example.com",
                display_name: "Me",
                role: "owner" as const,
            },
            members: [],
        };
        listContentPeople.mockResolvedValue(roster);
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW_ROW, error: null } },
        });
        const result = await getTabularReviewPeople(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toEqual({ ok: true, data: roster });
        expect(listContentPeople).toHaveBeenCalledWith(
            db,
            "tabular_review",
            REVIEW_ROW,
        );
    });

    it("404s an unreachable review without building a roster", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: false });
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW_ROW, error: null } },
        });
        const result = await getTabularReviewPeople(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({ ok: false, kind: "not_found" });
        expect(listContentPeople).not.toHaveBeenCalled();
    });

    it("reports a roster failure as an internal error", async () => {
        listContentPeople.mockResolvedValue({
            ok: false,
            detail: "connection reset",
        });
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: REVIEW_ROW, error: null } },
        });
        const result = await getTabularReviewPeople(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });
});

// The three endpoints behind the review's own sharing UI. They share one
// preamble — `access.manage` or nothing — and all three refuse to touch a
// project-owned review, whose access is the project's to decide.
describe("tabular review access grants", () => {
    const standalone = (overrides: Record<string, unknown> = {}) =>
        makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: {
                        id: "rev-1",
                        user_id: "user-1",
                        project_id: null,
                        org_id: null,
                        ...overrides,
                    },
                    error: null,
                },
            },
        });

    it("lists the direct grants for an owner", async () => {
        listContentGrants.mockResolvedValue({
            ok: true,
            grants: [{ id: "g1", email: "her@example.com", role: "viewer" }],
        });
        const { db } = standalone();
        const result = await getTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toEqual({
            ok: true,
            data: {
                scope: "direct",
                org_id: null,
                access_role: "owner",
                grants: [{ id: "g1", email: "her@example.com", role: "viewer" }],
            },
        });
    });

    it("reports project inheritance instead of a grant list", async () => {
        const { db } = standalone({ project_id: "proj-1", org_id: "org-1" });
        const result = await getTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toEqual({
            ok: true,
            data: {
                scope: "project",
                inherited_from_project_id: "proj-1",
                org_id: "org-1",
                access_role: "owner",
                grants: [],
            },
        });
        expect(listContentGrants).not.toHaveBeenCalled();
    });

    it("403s anyone below the owner tier", async () => {
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "editor",
        });
        const { db } = standalone();
        const result = await getTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Only a review owner can change who has access.",
        });
    });

    it("refuses to grant on a project-owned review", async () => {
        const { db } = standalone({ project_id: "proj-1" });
        const result = await grantTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: "her@example.com",
            role: "editor",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "conflict",
            code: "access_inherited",
            detail: "Project-owned reviews inherit access from their project.",
        });
        expect(upsertContentGrant).not.toHaveBeenCalled();
    });

    it("refuses a grant addressed to the caller", async () => {
        const { db } = standalone();
        const result = await grantTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: " ME@Example.com ",
            role: "editor",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "You cannot share a tabular review with yourself.",
        });
    });

    it("refuses `deny`, which is an organization-only override", async () => {
        const { db } = standalone();
        const result = await grantTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: "her@example.com",
            role: "deny",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "Deny is only available for organization members",
        });
    });

    it("passes the creator's email through so self-grants are caught", async () => {
        loadProfileUsersByEmail.mockResolvedValue({
            userByEmail: new Map(),
            userById: new Map([["user-1", { email: "me@example.com" }]]),
        });
        upsertContentGrant.mockResolvedValue({
            ok: true,
            grant: { id: "g1", email: "her@example.com", role: "editor" },
        });
        const { db } = standalone();
        const result = await grantTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: "her@example.com",
            role: "editor",
        });
        expect(result).toMatchObject({ ok: true });
        expect(upsertContentGrant).toHaveBeenCalledWith(db, {
            kind: "tabular_review",
            resourceId: "rev-1",
            email: "her@example.com",
            role: "editor",
            createdBy: "user-1",
            creatorEmail: "me@example.com",
        });
    });

    it("404s a revoke that matched no grant", async () => {
        deleteContentGrant.mockResolvedValue({ ok: true, removed: false });
        const { db } = standalone();
        const result = await revokeTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: "her@example.com",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Access grant not found",
        });
    });

    it("revokes an existing grant", async () => {
        deleteContentGrant.mockResolvedValue({ ok: true, removed: true });
        const { db } = standalone();
        const result = await revokeTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: "her@example.com",
        });
        expect(result).toEqual({ ok: true, data: null });
    });
});

describe("updateTabularReview", () => {
    const seeded = (overrides: Record<string, unknown> = {}) =>
        makeFakeDb({
            tables: {
                tabular_reviews: [
                    { data: { id: "rev-1", ...overrides }, error: null },
                    {
                        data: { id: "rev-1", columns_config: [], ...overrides },
                        error: null,
                    },
                ],
            },
        });

    it("rejects a project_id that is neither null nor a non-empty string", async () => {
        const { db, calls } = makeFakeDb();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: 7 },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "project_id must be a non-empty string or null",
        });
        expect(calls).toEqual([]);
    });

    it("rejects the retired shared_with input outright", async () => {
        // Sharing moved to the access endpoints; accepting the old field
        // would silently write a column nothing reads any more.
        const { db, calls } = makeFakeDb();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { shared_with: ["her@example.com"] },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "shared_with is no longer supported; use the tabular review access endpoints.",
        });
        expect(calls).toEqual([]);
    });

    it("403s a viewer changing review settings", async () => {
        // Content work is editor+: reshaping the grid is no more destructive
        // than any other edit an editor may already make.
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "viewer",
        });
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { title: "New" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Only a review editor can change review settings",
        });
    });

    it("lets an editor reshape the columns", async () => {
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "editor",
        });
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { columns_config: [{ index: 0, name: "X", prompt: "p" }] },
        });
        expect(result.ok).toBe(true);
    });

    it("403s a viewer changing columns", async () => {
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "viewer",
        });
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { columns_config: [{ index: 0, name: "X", prompt: "p" }] },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Only a review editor can change columns",
        });
    });

    it("403s an owner who did not create the review trying to move it", async () => {
        // Moving is creator-scoped: it changes which tenant owns the row.
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "owner",
        });
        const { db } = seeded({ user_id: "someone-else" });
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Only the review's creator can move a review",
        });
    });

    it("restamps org_id from the destination project on a move", async () => {
        // `tabular_reviews.org_id` is a denormalized copy of the project's
        // tenant that the SQL visibility predicates read directly, so a move
        // that left it stale would keep the review visible to an
        // organization it no longer belongs to.
        resolveContentOrgId.mockResolvedValue({ ok: true, orgId: "org-2" });
        const { db, calls } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result.ok).toBe(true);
        expect(calls.find((call) => call.op === "update")?.payload).toMatchObject(
            { project_id: "proj-9", org_id: "org-2" },
        );
        expect(resolveContentOrgId).toHaveBeenCalledWith(db, {
            projectId: "proj-9",
        });
    });

    it("refuses the move rather than guessing when the tenant lookup fails", async () => {
        resolveContentOrgId.mockResolvedValue({
            ok: false,
            detail: "connection reset",
        });
        const { db, calls } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result).toMatchObject({ ok: false, kind: "error" });
        expect(calls.some((call) => call.op === "update")).toBe(false);
    });

    it("leaves org_id alone when the request is not a move", async () => {
        const { db, calls } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { title: "Renamed" },
        });
        expect(result.ok).toBe(true);
        expect(
            calls.find((call) => call.op === "update")?.payload,
        ).not.toHaveProperty("org_id");
    });

    it("rejects an unsupported document_grouping", async () => {
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { document_grouping: "sideways" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "document_grouping must be document or folder",
        });
    });

    it("404s a move to a project the caller cannot reach", async () => {
        checkProjectAccess.mockResolvedValue({ ok: false });
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Target project not found",
        });
    });

    it("stamps updated_at and returns the updated row", async () => {
        const { db, calls } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { title: "New" },
        });
        expect(result.ok).toBe(true);
        const update = calls.find((call) => call.op === "update");
        expect(update?.payload).toMatchObject({ title: "New" });
        expect(
            (update?.payload as Record<string, unknown>).updated_at,
        ).toEqual(expect.any(String));
    });
});

describe("deleteTabularReview", () => {
    const ROW = {
        data: { id: "rev-1", user_id: "user-1", project_id: "proj-1" },
        error: null,
    };
    const OK = { data: null, error: null };

    it("deletes by id alone once container.delete is proved", async () => {
        // The old `.eq("user_id", userId)` filter made a project owner's
        // delete a silent 204 no-op: the row survived and came back on the
        // next load. The role check replaces it.
        ensureReviewAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "owner",
        });
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: [
                    { data: { ...ROW.data, user_id: "someone-else" }, error: null },
                    OK,
                ],
            },
        });
        const result = await deleteTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toEqual({ ok: true, data: null });
        expect(calls.find((call) => call.op === "delete")).toMatchObject({
            table: "tabular_reviews",
            filters: { id: "rev-1" },
        });
    });

    it.each(["editor", "viewer"] as const)(
        "403s a %s before any destructive statement",
        async (projectRole) => {
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: false,
                orgRole: null,
                projectRole,
            });
            const { db, calls } = makeFakeDb({
                tables: { tabular_reviews: [ROW, OK] },
            });
            const result = await deleteTabularReview(db, {
                reviewId: "rev-1",
                ...WHO,
            });
            expect(result).toMatchObject({
                ok: false,
                kind: "forbidden",
                detail: "You do not have permission to delete this review",
            });
            expect(calls.some((call) => call.op === "delete")).toBe(false);
        },
    );

    it("404s a review the caller cannot reach at all", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: false });
        const { db } = makeFakeDb({ tables: { tabular_reviews: [ROW, OK] } });
        const result = await deleteTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "not_found",
            detail: "Review not found",
        });
    });

    it("reports a delete error as an internal failure", async () => {
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: [ROW, { data: null, error: { m: "boom" } }],
            },
        });
        const result = await deleteTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });
});

describe("listTabularReviewIds", () => {
    it("pages the RPC until it returns an empty page", async () => {
        const pages = [
            [{ id: "a", user_id: "u" }],
            [{ id: "b", user_id: "u" }],
            [],
        ];
        let call = 0;
        const { db, rpcCalls } = makeFakeDb({
            rpc: () => ({ data: pages[call++] ?? [], error: null }),
        });
        const result = await listTabularReviewIds(db, {
            userId: "user-1",
            userEmail: "me@example.com",
            projectIdFilter: null,
            scope: "all",
            searchTerm: null,
        });
        expect(result).toEqual({
            ok: true,
            data: [
                { id: "a", user_id: "u" },
                { id: "b", user_id: "u" },
            ],
        });
        expect(rpcCalls).toHaveLength(3);
        // The offset advances by the number of rows actually returned, not by
        // the requested page size — a short page must not skip anything.
        expect(rpcCalls.map((r) => r.args.p_offset)).toEqual([0, 1, 2]);
    });

    it("stops and reports an RPC error", async () => {
        const { db } = makeFakeDb({
            rpc: () => ({ data: null, error: { m: "boom" } }),
        });
        const result = await listTabularReviewIds(db, {
            userId: "user-1",
            userEmail: undefined,
            projectIdFilter: null,
            scope: "all",
            searchTerm: null,
        });
        expect(result).toMatchObject({ ok: false, kind: "error" });
    });
});
