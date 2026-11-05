import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// The service delegates policy/filter/page selection to search_project_directory.
// Real permission matrices live in performance.projects.sql and
// performance.directory.sql. These HTTP tests protect workspace validation and
// forwarding at that boundary, with explicitly seeded authoritative RPC pages.

function mockSupabase() {
    return {
        from: vi.fn(() => {
            const q: Record<string, unknown> = {};
            for (const method of [
                "select",
                "update",
                "delete",
                "upsert",
                "insert",
                "eq",
                "neq",
                "in",
                "is",
                "or",
                "not",
                "ilike",
                "order",
                "limit",
                "range",
            ])
                q[method] = vi.fn(() => q);
            q.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
            q.maybeSingle = q.single;
            q.then = (resolve: (v: unknown) => unknown) =>
                Promise.resolve({ data: [], error: null }).then(resolve);
            return q;
        }),
        rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
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

// Every export of lib/access must survive — the other routers mounted by the
// app import from it at load time.
vi.mock("../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../lib/access")>()),
    checkProjectAccess: vi.fn(async () => ({ ok: false })),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
    getOrgRole: vi.fn(async () => null),
    resolveContentOrgId: vi.fn(async () => null),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";
import { createServerSupabase } from "../../lib/supabase";

const AUTH = ["Authorization", "Bearer test"] as const;

type Project = Record<string, unknown>;

function directorySearchDb(options: {
    pages?: Record<string, Project[]>;
    memberships?: { org_id: string; role: string }[];
}) {
    const memberships = options.memberships ?? [];
    const db = mockSupabase();
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe("search_project_directory");
        expect(args).toMatchObject({ p_user_id: "u1", p_user_email: "u1@test.local" });
        return { data: options.pages?.[String(args.p_workspace ?? "all")] ?? [], error: null };
    });
    const from = vi.fn((table: string) => {
        const query = db.from();
        if (table === "org_members") {
            query.maybeSingle = () => Promise.resolve({ data: memberships[0] ?? null, error: null });
        }
        return query;
    });
    return { db: { ...db, from, rpc }, rpc, from };
}

function useDb(handle: { db: unknown }) {
    vi.mocked(createServerSupabase).mockImplementationOnce(
        () => handle.db as ReturnType<typeof createServerSupabase>,
    );
}

const search = () =>
    request(app).get("/projects?view=directory-search&search=Matter").set(...AUTH);

// The caller created this org matter and then left the firm. The
// projects.user_id row survives their departure; their access does not.
const CREATED_ORG_PROJECT = {
    id: "p-firm",
    name: "Matter Firm",
    cm_number: "2026-0001",
    org_id: "o1",
    user_id: "u1",
    updated_at: "2026-09-01T00:00:00Z",
};

describe("GET /projects?view=directory-search", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns an empty authoritative page after membership is revoked", async () => {
        // "I created it" is not a verdict on its own. checkProjectAccess —
        // which every other read path uses — answers "no access" for a
        // non-member, so the picker was the one surface still offering a
        // matter that 404s the moment it is opened.
        const handle = directorySearchDb({
            pages: { all: [] },
            memberships: [],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it("preserves an authorized organization project from the RPC", async () => {
        // The control. The org branch re-admits it, so leaving the org is
        // what removes it — not the change itself.
        const handle = directorySearchDb({
            pages: { all: [CREATED_ORG_PROJECT] },
            memberships: [{ org_id: "o1", role: "member" }],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        expect(res.body.map((project: { id: string }) => project.id)).toEqual([
            "p-firm",
        ]);
    });

    it("preserves an authorized personal project without workspace membership", async () => {
        const handle = directorySearchDb({
            pages: { all: [
                {
                    id: "p-personal",
                    name: "Matter Personal",
                    org_id: null,
                    user_id: "u1",
                    updated_at: "2026-09-01T00:00:00Z",
                },
            ] },
            memberships: [],
        });
        useDb(handle);

        const res = await search();

        expect(res.status).toBe(200);
        expect(res.body.map((project: { id: string }) => project.id)).toEqual([
            "p-personal",
        ]);
    });

    it("uses one bounded RPC instead of transmitting every candidate project ID", async () => {
        const handle = directorySearchDb({ pages: { all: [CREATED_ORG_PROJECT] } });
        useDb(handle);
        const res = await search();
        expect(res.status).toBe(200);
        expect(handle.rpc).toHaveBeenCalledTimes(1);
        expect(handle.rpc).toHaveBeenCalledWith("search_project_directory", expect.objectContaining({
            p_search_term: "Matter", p_limit: 20, p_offset: 0,
        }));
        expect(handle.from).not.toHaveBeenCalledWith("project_org_access_overrides");
        expect(handle.from).not.toHaveBeenCalledWith("projects");
    });

    describe("narrowed to a workspace", () => {
        // The picker offers documents to attach, and a chat or review takes
        // documents from its own workspace only — so it searches that one.
        const FIRM = "11111111-1111-4111-8111-111111111111";
        const firmProject = { ...CREATED_ORG_PROJECT, org_id: FIRM };
        const personalProject = {
            id: "p-personal",
            name: "Matter Personal",
            org_id: null,
            user_id: "u1",
            updated_at: "2026-08-01T00:00:00Z",
        };
        const both = () =>
            directorySearchDb({
                pages: { all: [firmProject, personalProject], personal: [personalProject], [FIRM]: [firmProject] },
                memberships: [{ org_id: FIRM, role: "member" }],
            });
        const searchIn = (workspace: string) =>
            request(app)
                .get(
                    `/projects?view=directory-search&search=Matter&workspace=${workspace}`,
                )
                .set(...AUTH);
        const ids = (res: { body: { id: string }[] }) =>
            res.body.map((project) => project.id);

        it("finds both when no workspace is named", async () => {
            useDb(both());
            const res = await search();
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual(["p-firm", "p-personal"]);
        });

        it("leaves an organization's projects out of Personal", async () => {
            useDb(both());
            const res = await searchIn("personal");
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual(["p-personal"]);
        });

        it("leaves personal projects out of an organization", async () => {
            useDb(both());
            const res = await searchIn(FIRM);
            expect(res.status).toBe(200);
            expect(ids(res)).toEqual(["p-firm"]);
        });

        it("404s a workspace the caller is not in", async () => {
            useDb(
                directorySearchDb({
                    pages: { all: [personalProject] },
                    memberships: [],
                }),
            );
            const res = await searchIn(FIRM);
            expect(res.status).toBe(404);
            expect(res.body.code).toBe("workspace_not_found");
        });
    });
});
