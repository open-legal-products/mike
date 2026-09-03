// Unit tests for the review-record services behind the /tabular-review CRUD
// endpoints. They exist to pin the branching the routes used to carry inline:
// who may change what, which failures are 403 vs 404 vs 400, and the two
// compensating actions (delete the review when its rows cannot be built, page
// the ids RPC until it runs dry).

import { describe, it, expect, vi, beforeEach } from "vitest";

const { ensureReviewAccess, checkProjectAccess, filterAccessibleDocumentIds } =
    vi.hoisted(() => ({
        ensureReviewAccess: vi.fn(),
        checkProjectAccess: vi.fn(),
        filterAccessibleDocumentIds: vi.fn(),
    }));
vi.mock("../../../lib/access", () => ({
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
}));

const { findMissingUserEmails, loadProfileUsersByEmail } = vi.hoisted(() => ({
    findMissingUserEmails: vi.fn(),
    loadProfileUsersByEmail: vi.fn(),
}));
vi.mock("../../../lib/userLookup", () => ({
    findMissingUserEmails,
    loadProfileUsersByEmail,
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
    getTabularReviewDetail,
    getTabularReviewPeople,
    listTabularReviewIds,
    updateTabularReview,
} from "../tabular.reviews";
import { callTo, makeFakeDb } from "./fakeDb";

const WHO = { userId: "user-1", userEmail: "me@example.com" };

beforeEach(() => {
    vi.clearAllMocks();
    ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: true });
    checkProjectAccess.mockResolvedValue({ ok: true });
    filterAccessibleDocumentIds.mockResolvedValue([]);
    findMissingUserEmails.mockResolvedValue([]);
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

    it("returns the inserted review on the happy path", async () => {
        const { db } = makeFakeDb({
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
        });
        expect(result).toEqual({ ok: true, data: { id: "rev-1", title: "T" } });
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
    it("joins the shared_with emails to their profile display names", async () => {
        loadProfileUsersByEmail.mockResolvedValue({
            userByEmail: new Map([
                ["her@example.com", { display_name: "Her" }],
            ]),
            userById: new Map([
                ["user-1", { email: "me@example.com", display_name: "Me" }],
            ]),
        });
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: {
                        id: "rev-1",
                        user_id: "user-1",
                        shared_with: ["HER@example.com"],
                    },
                    error: null,
                },
            },
        });
        const result = await getTabularReviewPeople(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result.ok && result.data).toEqual({
            owner: {
                user_id: "user-1",
                email: "me@example.com",
                display_name: "Me",
            },
            members: [{ email: "her@example.com", display_name: "Her" }],
        });
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

    it("refuses to share a review with its own owner", async () => {
        const { db } = makeFakeDb();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { shared_with: ["ME@EXAMPLE.COM"] },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "You cannot share a tabular review with yourself.",
        });
    });

    it("403s a non-owner changing review settings", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: false });
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { title: "New" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Only the review owner can change review settings",
        });
    });

    it("403s a non-owner changing sharing", async () => {
        ensureReviewAccess.mockResolvedValue({ ok: true, isOwner: false });
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { shared_with: ["her@example.com"] },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "Only the review owner can change sharing",
        });
    });

    it("rejects an unknown share recipient by name", async () => {
        findMissingUserEmails.mockResolvedValue(["ghost@example.com"]);
        const { db } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { shared_with: ["ghost@example.com"] },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "ghost@example.com does not belong to a Mike user.",
        });
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
    it("scopes the delete to the caller's own review", async () => {
        const { db, calls } = makeFakeDb();
        const result = await deleteTabularReview(db, {
            reviewId: "rev-1",
            userId: "user-1",
        });
        expect(result).toEqual({ ok: true, data: null });
        expect(callTo(calls, "tabular_reviews")).toMatchObject({
            op: "delete",
            filters: { id: "rev-1", user_id: "user-1" },
        });
    });

    it("reports a delete error as an internal failure", async () => {
        const { db } = makeFakeDb({
            tables: { tabular_reviews: { data: null, error: { m: "boom" } } },
        });
        const result = await deleteTabularReview(db, {
            reviewId: "rev-1",
            userId: "user-1",
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
