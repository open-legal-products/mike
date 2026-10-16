// Unit tests for the review-record services behind the /tabular-review CRUD
// endpoints. They exist to pin the branching the routes used to carry inline:
// who may change what, which failures are 403 vs 404 vs 400, and the two
// compensating actions (delete the review when its rows cannot be built, page
// the ids RPC until it runs dry).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { attachActiveVersionPaths } from "../../../lib/documentVersions";

const {
    ensureReviewAccess,
    checkProjectAccess,
    filterAccessibleDocumentIds,
    resolveContentOrgId,
    resolveStandaloneOrgId,
    teamOrgIdOf,
} = vi.hoisted(() => ({
    ensureReviewAccess: vi.fn(),
    checkProjectAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    resolveContentOrgId: vi.fn(),
    resolveStandaloneOrgId: vi.fn(),
    teamOrgIdOf: vi.fn(),
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
    resolveStandaloneOrgId,
}));
// Which organizations are team ones is the database's to say; here every
// org_id a fixture carries names a team organization.
vi.mock("../../../lib/personalOrgs", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/personalOrgs")>()),
    teamOrgIdOf,
}));

// Where each document is filed is the database's to say too; by default
// every document named is in the review's own workspace.
const findDocumentsOutsideWorkspace = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/documentWorkspace", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/documentWorkspace")>()),
    findDocumentsOutsideWorkspace,
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
// Partial: filterReadableReviewRows is pure policy over the (mocked)
// filterAccessibleDocumentIds verdict and stays real.
vi.mock("../tabular.rows", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../tabular.rows")>()),
    fetchSourceDocuments,
    loadReviewRows,
}));

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
    resolveStandaloneOrgId.mockResolvedValue({ ok: true, orgId: null });
    teamOrgIdOf.mockImplementation(
        async (_db: unknown, orgId: string | null | undefined) => orgId ?? null,
    );
    findDocumentsOutsideWorkspace.mockResolvedValue([]);
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
    it("returns an internal failure without inserting a review when document access lookup fails", async () => {
        const error = new Error("Document access lookup failed");
        filterAccessibleDocumentIds.mockRejectedValueOnce(error);
        const { db, calls } = makeFakeDb();
        await expect(createTabularReview(db, {
            ...WHO, document_ids: ["doc-1"], columns_config: [], model: "claude-sonnet-5",
        })).resolves.toEqual({ ok: false, kind: "error", error });
        expect(calls.some(call => call.op === "insert")).toBe(false);
    });

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

    it("refuses documents from another workspace, before writing anything", async () => {
        resolveStandaloneOrgId.mockResolvedValue({ ok: true, orgId: "org-1" });
        filterAccessibleDocumentIds.mockResolvedValue(["mine", "firm"]);
        findDocumentsOutsideWorkspace.mockResolvedValue(["mine"]);
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: { data: { id: "rev-1" }, error: null },
            },
        });
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: ["mine", "firm"],
            columns_config: [],
            model: "claude-sonnet-5",
            org_id: "org-1",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            code: "document_workspace_mismatch",
        });
        // Judged against the organization the review is being started in.
        expect(findDocumentsOutsideWorkspace).toHaveBeenCalledWith(
            db,
            ["mine", "firm"],
            "org-1",
        );
        expect(calls.some((call) => call.op === "insert")).toBe(false);
    });

    it("files a review started on its own under the organization its author is working in", async () => {
        resolveStandaloneOrgId.mockResolvedValue({ ok: true, orgId: "org-1" });
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: { data: { id: "rev-1" }, error: null },
            },
        });
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            org_id: "org-1",
        });
        expect(result.ok).toBe(true);
        expect(resolveStandaloneOrgId).toHaveBeenCalledWith(db, {
            userId: "user-1",
            orgId: "org-1",
        });
        expect(
            calls.find((call) => call.op === "insert")?.payload,
        ).toMatchObject({ project_id: null, org_id: "org-1" });
        // It runs on that organization's keys and models from the start.
        expect(validateSelectedModel).toHaveBeenCalledWith(
            "claude-sonnet-5",
            "user-1",
            db,
            "org-1",
        );
        // There is no project to inherit from.
        expect(resolveContentOrgId).not.toHaveBeenCalled();
    });

    it("refuses an organization its author does not belong to, before writing anything", async () => {
        resolveStandaloneOrgId.mockResolvedValue({
            ok: false,
            detail: "You are not a member of that organization.",
        });
        const { db, calls } = makeFakeDb();
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            org_id: "org-elsewhere",
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "You are not a member of that organization.",
        });
        expect(validateSelectedModel).not.toHaveBeenCalled();
        expect(calls.some((call) => call.op === "insert")).toBe(false);
    });

    it("lets the project decide the organization, whatever org_id says", async () => {
        resolveContentOrgId.mockResolvedValue({ ok: true, orgId: "org-2" });
        checkProjectAccess.mockResolvedValue({
            ...OWNER,
            project: { id: "proj-1", org_id: "org-2" },
        });
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: { data: { id: "rev-1" }, error: null },
            },
        });
        const result = await createTabularReview(db, {
            ...WHO,
            document_ids: [],
            columns_config: [],
            model: "claude-sonnet-5",
            project_id: "proj-1",
            org_id: "org-1",
        });
        expect(result.ok).toBe(true);
        expect(resolveStandaloneOrgId).not.toHaveBeenCalled();
        expect(
            calls.find((call) => call.op === "insert")?.payload,
        ).toMatchObject({ project_id: "proj-1", org_id: "org-2" });
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
        // A Viewer can open the project, so "not found" would be a lie; the
        // read-only tier gets a refusal that names itself.
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "You do not have permission to write in this project.",
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
        loadReviewRows.mockResolvedValue([
            { id: "row-1", label: "Doc", source_document_ids: [] },
        ]);
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
                            row_id: "row-1",
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

describe("getTabularReviewDetail document visibility", () => {
    it("returns an internal failure when the document access lookup fails", async () => {
        const error = new Error("Document access lookup failed");
        filterAccessibleDocumentIds.mockRejectedValueOnce(error);
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: { id: "rev-1", document_ids: ["d1"] },
                    error: null,
                },
                tabular_cells: { data: [], error: null },
            },
        });
        await expect(
            getTabularReviewDetail(db, { reviewId: "rev-1", ...WHO }),
        ).resolves.toEqual({ ok: false, kind: "error", error });
        expect(callTo(calls, "documents")).toBeUndefined();
    });

    it("loads all authorised document metadata in bounded batches", async () => {
        const ids = Array.from({ length: 120 }, (_, index) => `d-${index}`);
        loadReviewRows.mockResolvedValue([
            { id: "row-folder", label: "Folder", source_document_ids: ids },
        ]);
        filterAccessibleDocumentIds.mockResolvedValueOnce(ids);
        const docs = ids.map((id) => ({
            id,
            current_version_id: `version-${id}`,
        }));
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: { id: "rev-1", document_ids: ids },
                    error: null,
                },
                tabular_cells: {
                    data: [
                        { id: "c1", row_id: "row-folder", content: "Answer" },
                    ],
                    error: null,
                },
                documents: [
                    { data: docs.slice(0, 50), error: null },
                    { data: docs.slice(50, 100), error: null },
                    { data: docs.slice(100), error: null },
                ],
            },
        });
        const result = await getTabularReviewDetail(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.documents).toEqual(docs);
        expect(result.data.rows.map((row) => row.id)).toEqual(["row-folder"]);
        expect(result.data.cells.map((cell) => cell.id)).toEqual(["c1"]);
        const lookups = calls.filter((call) => call.table === "documents");
        expect(
            lookups.map((call) => (call.filters.id as string[]).length),
        ).toEqual([50, 50, 20]);
        expect(lookups.flatMap((call) => call.filters.id)).toEqual(ids);
        expect(
            vi
                .mocked(attachActiveVersionPaths)
                .mock.calls.map(([, batch]) => batch.length),
        ).toEqual([50, 50, 20]);
    });

    it("returns an internal failure instead of partial metadata when a later batch fails", async () => {
        const ids = Array.from({ length: 60 }, (_, index) => `d-${index}`);
        filterAccessibleDocumentIds.mockResolvedValueOnce(ids);
        const error = { message: "Database unavailable" };
        const { db } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: { id: "rev-1", document_ids: ids },
                    error: null,
                },
                tabular_cells: { data: [], error: null },
                documents: [
                    {
                        data: ids.slice(0, 50).map((id) => ({ id })),
                        error: null,
                    },
                    { data: null, error },
                ],
            },
        });
        await expect(
            getTabularReviewDetail(db, { reviewId: "rev-1", ...WHO }),
        ).resolves.toEqual({ ok: false, kind: "error", error });
    });

    // Review access is not document access: a review in project Y can be
    // built from project X's documents, and a Y member without X access must
    // not read X's filenames or extracted cell text through the review.
    it("drops rows, cells, and documents the caller cannot read", async () => {
        loadReviewRows.mockResolvedValue([
            { id: "row-ok", label: "Mine.docx", source_document_ids: ["d-ok"] },
            {
                id: "row-hidden",
                label: "Their secret.docx",
                source_document_ids: ["d-hidden"],
            },
            {
                id: "row-mixed",
                label: "Folder",
                source_document_ids: ["d-ok", "d-hidden"],
            },
        ]);
        filterAccessibleDocumentIds.mockResolvedValue(["d-ok"]);
        const { db, calls } = makeFakeDb({
            tables: {
                tabular_reviews: {
                    data: { id: "rev-1", document_ids: ["d-ok", "d-hidden"] },
                    error: null,
                },
                tabular_cells: {
                    data: [
                        { id: "c-ok", row_id: "row-ok", content: "visible" },
                        { id: "c-hidden", row_id: "row-hidden", content: "secret" },
                        { id: "c-mixed", row_id: "row-mixed", content: "secret" },
                    ],
                    error: null,
                },
                documents: { data: [{ id: "d-ok" }], error: null },
            },
        });
        const result = await getTabularReviewDetail(db, {
            reviewId: "rev-1",
            ...WHO,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.rows.map((row) => row.id)).toEqual(["row-ok"]);
        expect(result.data.cells.map((cell) => cell.id)).toEqual(["c-ok"]);
        expect(filterAccessibleDocumentIds).toHaveBeenCalledWith(
            expect.arrayContaining(["d-ok", "d-hidden"]),
            WHO.userId,
            WHO.userEmail,
            db,
        );
        expect(callTo(calls, "documents")?.filters.id).toEqual(["d-ok"]);
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
            // A personal review can be shared with anyone.
            orgId: null,
        });
    });

    it("limits sharing an organization's review to that organization's members", async () => {
        upsertContentGrant.mockResolvedValue({
            ok: false,
            kind: "validation",
            detail: "her@example.com is not a member of this organization.",
        });
        const { db } = standalone({ org_id: "org-1" });
        const result = await grantTabularReviewAccess(db, {
            reviewId: "rev-1",
            ...WHO,
            email: "her@example.com",
            role: "editor",
        });
        expect(upsertContentGrant).toHaveBeenCalledWith(
            db,
            expect.objectContaining({ orgId: "org-1" }),
        );
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            detail: "her@example.com is not a member of this organization.",
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

    it("returns an internal failure without changing the review when document access lookup fails", async () => {
        const error = new Error("Document access lookup failed");
        filterAccessibleDocumentIds.mockRejectedValueOnce(error);
        const { db, calls } = seeded({ user_id: "user-1", document_ids: ["doc-1"] });
        await expect(updateTabularReview(db, {
            reviewId: "rev-1", ...WHO, body: { document_ids: ["doc-1", "doc-2"] },
        })).resolves.toEqual({ ok: false, kind: "error", error });
        expect(calls.every(call => call.op === "select")).toBe(true);
    });

    it.each([null, "proj-2"])("keeps rows and cell results on a move to %s", async project_id => {
        const { db, calls } = seeded({ user_id: "user-1", project_id: "proj-1", document_ids: ["d1"] });
        expect((await updateTabularReview(db, { reviewId: "rev-1", ...WHO, body: { project_id } })).ok).toBe(true);
        expect(calls.some(call => ["tabular_review_rows", "tabular_cells"].includes(call.table))).toBe(false);
    });

    it("keeps an editor's hidden sources and does not rebuild an unchanged document set", async () => {
        ensureReviewAccess.mockResolvedValue({ ...OWNER, isCreator: false, projectRole: "editor" });
        filterAccessibleDocumentIds.mockResolvedValue(["visible"]);
        const { db, calls } = seeded({ user_id: "other", document_ids: ["visible", "hidden"] });
        expect((await updateTabularReview(db, {
            reviewId: "rev-1", ...WHO, body: { document_ids: ["visible"] },
        })).ok).toBe(true);
        expect(calls.find(call => call.op === "update")?.payload).toMatchObject({ document_ids: ["visible", "hidden"] });
        expect(calls.some(call => ["tabular_review_rows", "tabular_cells"].includes(call.table))).toBe(false);
    });

    it.each([
        { document_ids: ["d1", "d1", "d2"] },
        { document_ids: ["d2", "d1", "d2"] },
    ])("keeps saved results when normalizing legacy document IDs %j", async ({ document_ids }) => {
        filterAccessibleDocumentIds.mockResolvedValue(["d1", "d2"]);
        const { db, calls } = seeded({ user_id: "user-1", document_ids });

        const result = await updateTabularReview(db, {
            reviewId: "rev-1", ...WHO, body: { document_ids: ["d2", "d1"] },
        });

        expect(result.ok).toBe(true);
        expect(calls.find(call => call.op === "update")?.payload).toMatchObject({
            document_ids: [...new Set(document_ids)],
        });
        expect(calls.some(call => ["tabular_review_rows", "tabular_cells"].includes(call.table))).toBe(false);
    });

    it.each([
        { document_ids: ["d1", "d2", "d3"] },
        { document_ids: ["d1"] },
        { document_ids: ["d1", "d3"] },
        { document_grouping: "folder" },
    ])("rebuilds rows for a changed document set or grouping: %j", async body => {
        filterAccessibleDocumentIds.mockResolvedValue(["d1", "d2", "d3"]);
        const { db, calls } = seeded({
            user_id: "user-1", document_ids: ["d1", "d1", "d2"], document_grouping: "document",
        });

        const result = await updateTabularReview(db, { reviewId: "rev-1", ...WHO, body });

        expect(result.ok).toBe(true);
        expect(calls).toContainEqual(expect.objectContaining({
            table: "tabular_review_rows", op: "delete", filters: { review_id: "rev-1" },
        }));
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

    it("keeps an organization's review in the organization when it is taken out of its project", async () => {
        // It becomes a standalone review of the same organization, not the
        // personal property of whoever moved it.
        const { db, calls } = seeded({
            user_id: "user-1",
            project_id: "proj-1",
            org_id: "org-1",
        });
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: null },
        });
        expect(result.ok).toBe(true);
        expect(calls.find((call) => call.op === "update")?.payload).toMatchObject(
            { project_id: null, org_id: "org-1" },
        );
        expect(resolveContentOrgId).not.toHaveBeenCalled();
    });

    it.each([
        ["a personal project", null],
        ["another organization's project", "org-2"],
    ])(
        "refuses to move an organization's review into %s",
        async (_label, destinationOrgId) => {
            resolveContentOrgId.mockResolvedValue({
                ok: true,
                orgId: destinationOrgId,
            });
            const { db, calls } = seeded({
                user_id: "user-1",
                project_id: null,
                org_id: "org-1",
            });
            const result = await updateTabularReview(db, {
                reviewId: "rev-1",
                ...WHO,
                body: { project_id: "proj-9" },
            });
            expect(result).toMatchObject({
                ok: false,
                kind: "validation",
                detail: "This review belongs to an organization and can only be moved to a project in the same organization.",
            });
            expect(calls.some((call) => call.op === "update")).toBe(false);
        },
    );

    it("moves an organization's review between projects of that organization", async () => {
        resolveContentOrgId.mockResolvedValue({ ok: true, orgId: "org-1" });
        const { db, calls } = seeded({
            user_id: "user-1",
            project_id: "proj-1",
            org_id: "org-1",
        });
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result.ok).toBe(true);
        expect(calls.find((call) => call.op === "update")?.payload).toMatchObject(
            { project_id: "proj-9", org_id: "org-1" },
        );
    });

    it("checks only the documents being added while the review stays where it is", async () => {
        // What the review already has is let through: one built across
        // workspaces before the rule keeps working.
        filterAccessibleDocumentIds.mockResolvedValue(["old", "new"]);
        const { db, calls } = seeded({
            user_id: "user-1",
            org_id: "org-1",
            document_ids: ["old"],
        });
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { document_ids: ["old", "new"] },
        });
        expect(result.ok).toBe(true);
        expect(findDocumentsOutsideWorkspace).toHaveBeenCalledWith(
            db,
            ["new"],
            "org-1",
        );
        expect(calls.some((call) => call.op === "update")).toBe(true);
    });

    it("refuses to add a document from another workspace", async () => {
        filterAccessibleDocumentIds.mockResolvedValue(["old", "new"]);
        findDocumentsOutsideWorkspace.mockResolvedValue(["new"]);
        const { db, calls } = seeded({
            user_id: "user-1",
            org_id: "org-1",
            document_ids: ["old"],
        });
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { document_ids: ["old", "new"] },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            code: "document_workspace_mismatch",
        });
        expect(calls.some((call) => call.op === "update")).toBe(false);
    });

    it("refuses to move a review into another workspace with its documents", async () => {
        // A personal review built from personal files, sent to a project of
        // an organization: every document would cross with it.
        resolveContentOrgId.mockResolvedValue({ ok: true, orgId: "org-2" });
        findDocumentsOutsideWorkspace.mockResolvedValue(["mine"]);
        const { db, calls } = seeded({
            user_id: "user-1",
            org_id: null,
            document_ids: ["mine"],
        });
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "validation",
            code: "document_workspace_mismatch",
        });
        expect(findDocumentsOutsideWorkspace).toHaveBeenCalledWith(
            db,
            ["mine"],
            "org-2",
        );
        expect(calls.some((call) => call.op === "update")).toBe(false);
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

    it("403s a move into a project where the caller is only a viewer", async () => {
        // A move contributes the review to the destination exactly as
        // creating it there would, so it needs the same content.edit gate.
        checkProjectAccess.mockResolvedValue({
            ok: true,
            isCreator: false,
            orgRole: null,
            projectRole: "viewer",
            project: { id: "proj-9" },
        });
        const { db, calls } = seeded();
        const result = await updateTabularReview(db, {
            reviewId: "rev-1",
            ...WHO,
            body: { project_id: "proj-9" },
        });
        expect(result).toMatchObject({
            ok: false,
            kind: "forbidden",
            detail: "You do not have permission to write in this project.",
        });
        expect(calls.some((call) => call.op === "update")).toBe(false);
    });

    it.each([["proj-9"], [null]])(
        "403s a creator downgraded to viewer on the source moving to %s",
        async (destination) => {
            // Authorship is not standing: a creator reduced to Viewer must not
            // pull the review out of the matter it lives in.
            ensureReviewAccess.mockResolvedValue({
                ok: true,
                isCreator: true,
                orgRole: null,
                projectRole: "viewer",
            });
            const { db, calls } = seeded();
            const result = await updateTabularReview(db, {
                reviewId: "rev-1",
                ...WHO,
                body: { project_id: destination },
            });
            expect(result).toMatchObject({
                ok: false,
                kind: "forbidden",
                detail: "You do not have permission to move this review.",
            });
            expect(calls.some((call) => call.op === "update")).toBe(false);
        },
    );

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
