import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// DELETE /single-documents/:documentId — the container's rule, not `user_id`.
//
// This route used to scope its lookup with `.eq("user_id", userId)`, which
// answered "Document not found" for anything the caller had not personally
// uploaded. Two consequences:
//
//   * an organization admin could not remove a colleague's document from a
//     matter the firm owns, and
//   * once account deletion started blanking documents.user_id instead of
//     destroying organization content, NOBODY could remove a departed
//     colleague's document — the row was stranded in a project the
//     organization is supposed to control.
//
// It now resolves the document through ensureDocAccess and applies the same
// creator-scoped rule as DELETE .../versions/:versionId.
// ---------------------------------------------------------------------------

const { ensureDocAccess } = vi.hoisted(() => ({ ensureDocAccess: vi.fn() }));

type QueryResult = { data: unknown; error: unknown };
let tables: Record<string, QueryResult>;
const deletes: string[] = [];

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    for (const m of [
        "select",
        "update",
        "upsert",
        "insert",
        "eq",
        "in",
        "is",
        "or",
        "not",
        "order",
        "limit",
    ])
        q[m] = vi.fn(() => q);
    q.delete = vi.fn(() => {
        deletes.push(table);
        return q;
    });
    const result = () => tables[table] ?? { data: null, error: null };
    q.single = vi.fn(() => Promise.resolve(result()));
    q.maybeSingle = vi.fn(() => Promise.resolve(result()));
    q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result()).then(resolve);
    return q;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(async () => ({ data: null, error: null })),
        auth: {
            getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
        },
    })),
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

// Only the verdict is stubbed; creatorScopedAllowed stays real, because the
// rule under test IS that helper's "the creator is gone, so the container's
// Owners inherit" branch.
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    ensureDocAccess: (...args: unknown[]) => ensureDocAccess(...args),
}));

vi.mock("../../lib/dbq/enqueue", () => ({
    enqueueStorageCleanup: vi.fn(async () => {}),
    enqueueDbJob: vi.fn(async () => ({ ok: true })),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const DOC = "11111111-1111-4111-8111-111111111111";

const access = (projectRole: string, isCreator: boolean) => ({
    ok: true,
    isCreator,
    orgRole: "admin",
    projectRole,
});

describe("DELETE /single-documents/:documentId", () => {
    beforeEach(() => {
        deletes.length = 0;
        tables = {
            documents: {
                data: {
                    id: DOC,
                    user_id: "u2",
                    project_id: "p1",
                    org_id: "o1",
                    workflow_id: null,
                },
                error: null,
            },
            document_versions: { data: [], error: null },
        };
        ensureDocAccess.mockResolvedValue(access("owner", false));
    });

    it("deletes a detached document nobody else could reach", async () => {
        // user_id NULL: the uploader's account is gone, so "only the creator
        // may delete" would mean nobody ever can.
        tables.documents = {
            data: {
                id: DOC,
                user_id: null,
                project_id: "p1",
                org_id: "o1",
                workflow_id: null,
            },
            error: null,
        };

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
        expect(deletes).toContain("documents");
    });

    it("deletes the caller's own document", async () => {
        ensureDocAccess.mockResolvedValue(access("owner", true));

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
    });

    it("refuses a live colleague's document with 403, not a fake 404", async () => {
        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "You do not have permission to delete this document.",
        );
        expect(deletes).not.toContain("documents");
    });

    it("keeps 404 for a document the caller cannot see at all", async () => {
        ensureDocAccess.mockResolvedValue({ ok: false });

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(404);
        expect(deletes).not.toContain("documents");
    });

    it("lets a workflow asset be removed by anyone who may edit the workflow", async () => {
        tables.documents = {
            data: {
                id: DOC,
                user_id: "u2",
                project_id: null,
                org_id: "o1",
                workflow_id: "w1",
            },
            error: null,
        };
        ensureDocAccess.mockResolvedValue(access("editor", false));

        const res = await request(app)
            .delete(`/single-documents/${DOC}`)
            .set(...AUTH);

        expect(res.status).toBe(204);
    });
});
