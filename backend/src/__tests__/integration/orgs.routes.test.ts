import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ownerlessRpcResult } from "../helpers/ownerlessRpc";
import { handoverRpcResult } from "../helpers/handoverRpc";

// ---------------------------------------------------------------------------
// Organizations, invitations and project organization overrides, over HTTP.
//
// lib/orgs.ts and lib/projectAccess.ts are unit-tested against their own
// fakes; what this file pins down is the part only the router owns — which
// failure kind becomes which status code, who is allowed through each
// endpoint, and the response shapes the web UI is written against.
//
// The Supabase stub here is STATEFUL, so an invitation created through POST
// really is the row a later accept/cancel finds.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let tables: Record<string, Row[]>;
let idCounter: number;
let currentUser: { id: string; email: string };
// Force one table's writes to fail, so the router's db_error arm can be
// exercised over real HTTP rather than reasoned about.
let writeErrors: Record<string, { message: string; code?: string }>;

function resetState() {
    idCounter = 1;
    writeErrors = {};
    currentUser = { id: "owner-1", email: "owner@firm.example" };
    tables = {
        organizations: [{ id: "org-1", name: "Acme LLP", created_by: "owner-1" }],
        org_members: [
            {
                id: "m-1",
                org_id: "org-1",
                user_id: "owner-1",
                role: "owner",
                created_at: "t1",
            },
            {
                id: "m-2",
                org_id: "org-1",
                user_id: "member-1",
                role: "member",
                created_at: "t2",
            },
        ],
        org_invitations: [],
        user_profiles: [
            {
                user_id: "owner-1",
                email: "owner@firm.example",
                display_name: "Ada",
            },
            {
                user_id: "member-1",
                email: "member@firm.example",
                display_name: "Mel",
            },
        ],
        projects: [
            {
                id: "proj-1",
                user_id: "owner-1",
                org_id: "org-1",
                // Open to the whole organization: the cases below are about
                // roles and overrides, not about privacy.
                visibility: "organization",
                name: "Matter Alpha",
                created_at: "t1",
            },
        ],
        chats: [
            {
                id: "chat-1",
                user_id: "member-1",
                project_id: "proj-1",
                org_id: "org-1",
                title: "Research thread",
                created_at: "t2",
            },
        ],
        tabular_reviews: [
            {
                id: "review-1",
                user_id: "owner-1",
                project_id: "proj-1",
                org_id: "org-1",
                title: "Disclosure review",
                created_at: "t3",
            },
        ],
        workflows: [
            {
                id: "workflow-1",
                user_id: "owner-1",
                org_id: "org-1",
                visibility: "organization",
                title: "Disclosure workflow",
                type: "tabular",
                created_at: "t4",
            },
        ],
        project_access_grants: [],
        project_org_access_overrides: [],
        audit_events: [],
        documents: [],
        project_subfolders: [],
    };
}
resetState();

function query(table: string) {
    const filters: (
        | { type: "eq"; col: string; val: unknown }
        | { type: "neq"; col: string; val: unknown }
        | { type: "in"; col: string; vals: unknown[] }
    )[] = [];
    let op: "select" | "insert" | "update" | "delete" | "upsert" = "select";
    let payload: Row | Row[] | null = null;
    let conflictCols: string[] = [];

    const ensure = () => (tables[table] ??= []);
    const matches = (rows: Row[]) =>
        rows.filter((r) =>
            filters.every((f) => {
                if (f.type === "eq") return r[f.col] === f.val;
                if (f.type === "neq") return r[f.col] !== f.val;
                return f.vals.includes(r[f.col]);
            }),
        );

    function resolveMany(): Promise<{
        data: Row[] | null;
        error: { message: string; code?: string } | null;
    }> {
        const arr = ensure();
        if (op !== "select" && writeErrors[table]) {
            return Promise.resolve({ data: null, error: writeErrors[table] });
        }
        if (op === "insert" || op === "upsert") {
            const rows = Array.isArray(payload) ? payload : [payload as Row];
            const out: Row[] = [];
            for (const r of rows) {
                const existing =
                    op === "upsert" && conflictCols.length > 0
                        ? arr.find((e) =>
                              conflictCols.every((c) => e[c] === r[c]),
                          )
                        : undefined;
                if (existing) {
                    Object.assign(existing, r);
                    out.push(existing);
                } else {
                    const created = {
                        id: `row-${idCounter++}`,
                        created_at: `t${idCounter}`,
                        ...r,
                    };
                    arr.push(created);
                    out.push(created);
                }
            }
            return Promise.resolve({ data: out, error: null });
        }
        const matched = matches(arr);
        if (op === "update") {
            for (const r of matched) Object.assign(r, payload as Row);
            return Promise.resolve({ data: matched, error: null });
        }
        if (op === "delete") {
            tables[table] = arr.filter((r) => !matched.includes(r));
            return Promise.resolve({ data: matched, error: null });
        }
        return Promise.resolve({ data: matched, error: null });
    }

    const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        limit: () => builder,
        range: () => builder,
        eq: (col: string, val: unknown) => {
            filters.push({ type: "eq", col, val });
            return builder;
        },
        is: (col: string, val: unknown) => {
            // Existing fixtures omit nullable columns.
            for (const row of tables[table] ?? []) if (!(col in row)) row[col] = null;
            filters.push({ type: "eq", col, val });
            return builder;
        },
        // `.not(col, "is", null)` — the only negation the routes use.
        not: (col: string, operator: string, val: unknown) => {
            if (operator === "is" && val === null) {
                filters.push({ type: "neq", col, val: null });
            }
            return builder;
        },
        neq: (col: string, val: unknown) => {
            filters.push({ type: "neq", col, val });
            return builder;
        },
        in: (col: string, vals: unknown[]) => {
            filters.push({ type: "in", col, vals });
            return builder;
        },
        insert: (p: Row | Row[]) => {
            op = "insert";
            payload = p;
            return builder;
        },
        upsert: (p: Row | Row[], opts?: { onConflict?: string }) => {
            op = "upsert";
            payload = p;
            conflictCols = (opts?.onConflict ?? "")
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean);
            return builder;
        },
        update: (p: Row) => {
            op = "update";
            payload = p;
            return builder;
        },
        delete: () => {
            op = "delete";
            return builder;
        },
        single: async () => {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        },
        maybeSingle: async () => {
            const { data, error } = await resolveMany();
            return { data: data?.[0] ?? null, error };
        },
        then: (
            resolve: (v: {
                data: Row[] | null;
                error: { message: string; code?: string } | null;
            }) => unknown,
            reject?: (e: unknown) => unknown,
        ) => resolveMany().then(resolve, reject),
    };
    return builder;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: (t: string) => query(t),
        rpc: vi.fn((name?: string, args?: Record<string, unknown>) => {
            if (name === "soft_delete_organization") {
                if (writeErrors.organizations) return Promise.resolve({ data: null, error: writeErrors.organizations });
                const org = tables.organizations.find((row) => row.id === args?.p_org_id);
                if (org) org.deleted_at = new Date().toISOString();
                return Promise.resolve({ data: null, error: null });
            }
            // Whether an item has an Owner left is the database's to say.
            const ownerless = ownerlessRpcResult(tables, name ?? "", args);
            if (ownerless) return Promise.resolve(ownerless);
            // ... and so is what a departing member alone owns.
            const handover = handoverRpcResult(tables, name ?? "", args);
            if (handover) return Promise.resolve(handover);
            // The one function these routes rely on for its effect: replace
            // an organization's model list for one provider.
            if (name === "replace_org_router_models" && args) {
                if (writeErrors.org_router_models)
                    return Promise.resolve({
                        data: null,
                        error: writeErrors.org_router_models,
                    });
                const kept = (tables.org_router_models ?? []).filter(
                    (row) =>
                        row.org_id !== args.target_org_id ||
                        row.router !== args.target_router,
                );
                tables.org_router_models = [
                    ...kept,
                    ...(args.target_model_ids as string[]).map(
                        (model_id, sort_order) => ({
                            org_id: args.target_org_id,
                            router: args.target_router,
                            model_id,
                            sort_order,
                        }),
                    ),
                ];
            }
            return Promise.resolve({ data: [], error: null });
        }),
        auth: {
            getUser: () =>
                Promise.resolve({
                    data: { user: { id: currentUser.id } },
                    error: null,
                }),
        },
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = currentUser.id;
        res.locals.userEmail = currentUser.email;
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const as = (id: string, email: string) => {
    currentUser = { id, email };
};

beforeEach(() => {
    vi.clearAllMocks();
    resetState();
});

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

describe("GET /orgs", () => {
    it("returns each membership with the caller's role and roster size", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                id: "org-1",
                name: "Acme LLP",
                role: "member",
                member_count: 2,
            }),
        ]);
    });

    it("is empty for someone in no organization", async () => {
        as("loner", "loner@example.com");
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});

// Every account has an organization of its own, behind the scenes. Over HTTP
// it is not an organization at all: not listed, and every route that names
// one answers for it as for an id that names nothing — to its owner too.
describe("a personal organization", () => {
    beforeEach(() => {
        tables.organizations.push({
            id: "mine",
            name: "Personal",
            kind: "personal",
            personal_user_id: "owner-1",
            created_by: "owner-1",
        });
        tables.org_members.push({
            id: "m-mine",
            org_id: "mine",
            user_id: "owner-1",
            role: "owner",
            created_at: "t0",
        });
    });

    it("is not among the caller's organizations", async () => {
        const res = await request(app).get("/orgs").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body.map((org: { id: string }) => org.id)).toEqual([
            "org-1",
        ]);
    });

    it.each([
        ["get", "/orgs/mine", undefined],
        ["patch", "/orgs/mine", { name: "Mine, renamed" }],
        ["delete", "/orgs/mine", undefined],
        ["get", "/orgs/mine/logo", undefined],
        ["put", "/orgs/mine/logo", { data_url: "data:image/png;base64,AAAA" }],
        ["delete", "/orgs/mine/logo", undefined],
        ["get", "/orgs/mine/resources", undefined],
        ["get", "/orgs/mine/members", undefined],
        ["patch", "/orgs/mine/members/owner-1", { role: "member" }],
        ["delete", "/orgs/mine/members/owner-1", undefined],
        ["get", "/orgs/mine/members/owner-1/handover", undefined],
        ["post", "/orgs/mine/invitations", { email: "friend@example.com" }],
        ["get", "/orgs/mine/invitations", undefined],
        ["delete", "/orgs/mine/invitations/inv-1", undefined],
        ["post", "/orgs/mine/invitations/inv-1/resend", undefined],
        ["get", "/orgs/mine/api-keys", undefined],
        ["put", "/orgs/mine/api-keys/policy", { allow_personal: false }],
        ["put", "/orgs/mine/api-keys/openrouter/models", { models: [] }],
        ["put", "/orgs/mine/api-keys/openai", { api_key: "sk-test" }],
        ["patch", "/orgs/mine/api-keys/openai", { enabled: false }],
    ] as const)("%s %s answers 404, to its owner too", async (method, path, body) => {
        const before = JSON.stringify(tables);
        const pending = request(app)[method](path).set(...AUTH);
        const res = await (body ? pending.send(body) : pending);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ detail: "Organization not found" });
        // Nothing was renamed, removed, invited or saved on the way.
        expect(JSON.stringify(tables)).toBe(before);
    });

    it("is refused by every route that names an organization, including ones added later", () => {
        // The cases above are the routes that exist today. This reads the
        // router itself, so a new /:orgId route cannot be added without the
        // guard: each must use requireOrgAuth, never requireAuth alone.
        const source = readFileSync(
            resolve(__dirname, "../../modules/orgs/orgs.routes.ts"),
            "utf8",
        );
        const routes = [
            ...source.matchAll(
                /orgsRouter\.(?:get|post|put|patch|delete)\(\s*"(\/:orgId[^"]*)",\s*(\w+),/g,
            ),
        ].map(([, path, guard]) => ({ path, guard }));
        expect(routes.length).toBeGreaterThanOrEqual(21);
        expect(routes.filter((route) => route.guard !== "requireOrgAuth")).toEqual(
            [],
        );
    });

    it("leaves a team organization's routes as they were", async () => {
        const res = await request(app).get("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: "org-1", role: "owner" });
    });
});

describe("POST /orgs", () => {
    it("creates the org and makes the caller its first owner", async () => {
        as("founder", "founder@new.example");
        const res = await request(app)
            .post("/orgs")
            .set(...AUTH)
            .send({ name: "  New Firm  " });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: "New Firm", role: "owner" });
        expect(
            tables.org_members.filter((m) => m.user_id === "founder"),
        ).toEqual([expect.objectContaining({ role: "owner" })]);
    });

    it("400s a blank name", async () => {
        const res = await request(app)
            .post("/orgs")
            .set(...AUTH)
            .send({ name: "   " });
        expect(res.status).toBe(400);
    });
});

describe("org membership", () => {
    it("404s an org the caller does not belong to", async () => {
        as("stranger", "stranger@example.com");
        const res = await request(app).get("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("lists members with their identity for the roster UI", async () => {
        const res = await request(app).get("/orgs/org-1/members").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toEqual([
            expect.objectContaining({
                user_id: "owner-1",
                role: "owner",
                email: "owner@firm.example",
                display_name: "Ada",
            }),
            expect.objectContaining({
                user_id: "member-1",
                role: "member",
                email: "member@firm.example",
            }),
        ]);
    });

    it("409s an attempt to demote the last owner", async () => {
        const res = await request(app)
            .patch("/orgs/org-1/members/owner-1")
            .set(...AUTH)
            .send({ role: "member" });
        expect(res.status).toBe(409);
        expect(res.body.detail).toBe(
            "An organization must keep at least one owner.",
        );
    });

    it("403s a plain member trying to re-role somebody", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .patch("/orgs/org-1/members/owner-1")
            .set(...AUTH)
            .send({ role: "member" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization admin can do that.");
    });

    it("403s an admin trying to appoint another admin, naming the owner role", async () => {
        // A separate refusal from the member's: "only an admin can do that"
        // would be untrue for somebody who is one.
        tables.org_members[1].role = "admin";
        tables.org_members.push({
            id: "m-3",
            org_id: "org-1",
            user_id: "member-2",
            role: "member",
            created_at: "t3",
        });
        as("member-1", "member@firm.example");
        const res = await request(app)
            .patch("/orgs/org-1/members/member-2")
            .set(...AUTH)
            .send({ role: "admin" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization owner can do that.");
        expect(tables.org_members[2].role).toBe("member");
    });

    it("403s an admin trying to remove an owner", async () => {
        tables.org_members[1].role = "admin";
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1/members/owner-1")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization owner can do that.");
        expect(tables.org_members).toHaveLength(2);
    });

    it("lets a member leave on their own (204)", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1/members/member-1")
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.org_members.map((m) => m.user_id)).toEqual(["owner-1"]);
    });

    // A member's public projects and workflows that nobody else owns are
    // handed to a named successor before they can go.
    describe("with work only they own", () => {
        beforeEach(() => {
            tables.projects.push({
                id: "proj-public",
                user_id: "member-1",
                org_id: "org-1",
                visibility: "organization",
                name: "Public matter",
            });
            tables.chats.push({
                id: "chat-own",
                user_id: "member-1",
                project_id: null,
                org_id: "org-1",
            });
        });

        it("tells an admin what removing them would hand over and delete", async () => {
            const res = await request(app)
                .get("/orgs/org-1/members/member-1/handover")
                .set(...AUTH);
            expect(res.status).toBe(200);
            expect(res.body).toEqual({
                projects: [{ id: "proj-public", title: "Public matter" }],
                workflows: [],
                chats: 1,
                reviews: 0,
                documents: 0,
                sharedChats: 0,
                sharedReviews: 0,
                sharedDocuments: 0,
                privateProjects: 0,
                privateWorkflows: 0,
            });
        });

        it("tells the member the same about leaving, and nobody else", async () => {
            as("member-1", "member@firm.example");
            const own = await request(app)
                .get("/orgs/org-1/members/member-1/handover")
                .set(...AUTH);
            expect(own.status).toBe(200);
            // A plain member asking about somebody else.
            const other = await request(app)
                .get("/orgs/org-1/members/owner-1/handover")
                .set(...AUTH);
            expect(other.status).toBe(403);
        });

        it("defaults the bulk handover to a remaining organization owner", async () => {
            const res = await request(app).delete("/orgs/org-1/members/member-1").set(...AUTH);
            expect(res.status).toBe(204);
            expect(tables.org_members.map((m) => m.user_id)).toEqual(["owner-1"]);
            expect(tables.projects.find((p) => p.id === "proj-public")).toBeDefined();
        });

        it("400s a successor who is not another member", async () => {
            const res = await request(app)
                .delete("/orgs/org-1/members/member-1?assign_to=member-1")
                .set(...AUTH);
            expect(res.status).toBe(400);
            expect(tables.org_members).toHaveLength(2);
        });

        it("hands the work to the named successor and removes the member (204)", async () => {
            const res = await request(app)
                .delete("/orgs/org-1/members/member-1?assign_to=owner-1")
                .set(...AUTH);
            expect(res.status).toBe(204);
            expect(tables.org_members.map((m) => m.user_id)).toEqual([
                "owner-1",
            ]);
            // Org owners already own public items; their grant is implicit.
            expect(tables.project_org_access_overrides).toEqual([]);
        });

        it("lets a member who is leaving name their own successor", async () => {
            as("member-1", "member@firm.example");
            const res = await request(app)
                .delete("/orgs/org-1/members/member-1?assign_to=owner-1")
                .set(...AUTH);
            expect(res.status).toBe(204);
        });
    });

    it("has no endpoint that adds a member directly", async () => {
        // Membership only ever arrives through an accepted invitation.
        const res = await request(app)
            .post("/orgs/org-1/members")
            .set(...AUTH)
            .send({ email: "someone@example.com", role: "member" });
        expect(res.status).toBe(404);
    });
});

describe("organization workspace", () => {
    it("lists only organization-scoped projects and workflows", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .get("/orgs/org-1/resources")
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body.projects).toEqual([
            expect.objectContaining({ id: "proj-1", org_id: "org-1" }),
        ]);
        expect(res.body.workflows).toEqual([
            expect.objectContaining({ id: "workflow-1", org_id: "org-1" }),
        ]);
        expect(res.body).not.toHaveProperty("chats");
        expect(res.body).not.toHaveProperty("reviews");
    });

    it("hides the resource inventory from non-members", async () => {
        as("stranger", "stranger@example.com");
        const res = await request(app)
            .get("/orgs/org-1/resources")
            .set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("soft-deletes a nonempty organization without purging its content", async () => {
        const before = JSON.stringify(tables.projects);
        const res = await request(app).delete("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.organizations[0].deleted_at).toBeTruthy();
        expect(JSON.stringify(tables.projects)).toBe(before);
    });

    it("reports a failed lifecycle transaction as an error", async () => {
        writeErrors.organizations = { message: "boom" };
        const res = await request(app).delete("/orgs/org-1").set(...AUTH);
        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("boom");
        expect(tables.organizations[0].deleted_at).toBeUndefined();
    });

    it.each([
        ["chats", "chats"],
        ["tabular-reviews", "tabular_reviews"],
        ["projects", "projects"],
    ])("lets an owner delete all organization %s", async (kind, table) => {
        expect(
            tables[table].filter((row) => row.org_id === "org-1").length,
        ).toBeGreaterThan(0);
        const res = await request(app)
            .delete(`/orgs/org-1/data/${kind}`)
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables[table].filter((row) => row.org_id === "org-1")).toEqual([]);
        expect(tables.organizations).toHaveLength(1);
        expect(tables.audit_events.at(-1)).toMatchObject({
            action: "org.data.deleted",
        });
    });

    it("refuses organization data deletion to anyone but an owner", async () => {
        tables.org_members[1].role = "admin";
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1/data/projects")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization owner can do that.");
        expect(
            tables.projects.filter((row) => row.org_id === "org-1").length,
        ).toBeGreaterThan(0);
    });

    it("answers 404 for a kind of organization data that does not exist", async () => {
        const res = await request(app)
            .delete("/orgs/org-1/data/everything")
            .set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("refuses organization deletion to a plain member", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(tables.organizations).toHaveLength(1);
    });

    it("refuses organization deletion to an admin, even an empty one", async () => {
        tables.org_members[1].role = "admin";
        tables.projects = [];
        tables.chats = [];
        tables.tabular_reviews = [];
        tables.workflows = [];
        as("member-1", "member@firm.example");
        const res = await request(app)
            .delete("/orgs/org-1")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe("Only an organization owner can do that.");
        expect(tables.organizations).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

async function invite(email: string, role = "member") {
    return request(app)
        .post("/orgs/org-1/invitations")
        .set(...AUTH)
        .send({ email, role });
}

describe("organization invitations", () => {
    it("an owner invites an email, and no membership appears", async () => {
        const res = await invite("New@Hire.example", "admin");
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            email: "new@hire.example",
            role: "admin",
            status: "pending",
        });
        expect(tables.org_members).toHaveLength(2);
    });

    it("403s a plain member trying to invite", async () => {
        as("member-1", "member@firm.example");
        const res = await invite("new@hire.example");
        expect(res.status).toBe(403);
    });

    it("409s a duplicate live invitation", async () => {
        await invite("new@hire.example");
        const res = await invite("new@hire.example");
        expect(res.status).toBe(409);
    });

    it("400s a malformed address", async () => {
        const res = await invite("not-an-email");
        expect(res.status).toBe(400);
    });

    // 'owner' is a tier this product removed. Answering a request for it with
    // a quiet 'member' invitation and a 201 would tell the caller their
    // choice was honoured when it was replaced, so the retired names get the
    // same 400 that updateMember and project sharing already give.
    it("400s a retired role name rather than quietly downgrading it", async () => {
        for (const role of ["owner", "manager", "editor"]) {
            const res = await request(app)
                .post("/orgs/org-1/invitations")
                .set(...AUTH)
                .send({ email: "new@hire.example", role });
            expect(res.status).toBe(400);
        }
        expect(tables.org_invitations ?? []).toHaveLength(0);
    });

    it("still defaults an omitted role to member", async () => {
        const res = await request(app)
            .post("/orgs/org-1/invitations")
            .set(...AUTH)
            .send({ email: "new@hire.example" });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ role: "member" });
    });

    it("shows an admin the invitation roster, and hides it from members", async () => {
        await invite("new@hire.example");
        const admin = await request(app)
            .get("/orgs/org-1/invitations")
            .set(...AUTH);
        expect(admin.status).toBe(200);
        expect(admin.body).toEqual([
            expect.objectContaining({
                email: "new@hire.example",
                status: "pending",
                invited_by_email: "owner@firm.example",
            }),
        ]);

        as("member-1", "member@firm.example");
        const member = await request(app)
            .get("/orgs/org-1/invitations")
            .set(...AUTH);
        expect(member.status).toBe(403);
    });

    it("surfaces the invitation to its recipient and joins them on accept", async () => {
        const created = await invite("new@hire.example", "admin");
        const invitationId = created.body.id as string;

        as("new-hire", "New@Hire.example");
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.status).toBe(200);
        expect(mine.body).toEqual([
            expect.objectContaining({
                id: invitationId,
                org_id: "org-1",
                org_name: "Acme LLP",
                role: "admin",
            }),
        ]);

        const accepted = await request(app)
            .post(`/user/invitations/${invitationId}/accept`)
            .set(...AUTH);
        expect(accepted.status).toBe(200);
        expect(accepted.body).toEqual({ org_id: "org-1", role: "admin" });
        expect(
            tables.org_members.find((m) => m.user_id === "new-hire"),
        ).toMatchObject({ role: "admin" });
    });

    it("204s a decline and creates no membership", async () => {
        const created = await invite("new@hire.example");
        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/decline`)
            .set(...AUTH);
        expect(res.status).toBe(204);
        expect(tables.org_members).toHaveLength(2);
        expect(tables.org_invitations[0].status).toBe("declined");
    });

    it("404s somebody else's invitation rather than confirming it exists", async () => {
        const created = await invite("new@hire.example");
        as("intruder", "intruder@elsewhere.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(404);
        expect(tables.org_members).toHaveLength(2);
    });

    it("410s an expired invitation, which is not the same as a missing one", async () => {
        const created = await invite("new@hire.example");
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();

        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(410);
        expect(res.body.detail).toBe("That invitation has expired.");
        // ...and it is not offered in the recipient's list either.
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.body).toEqual([]);
    });

    it("an admin cancels an invitation, and acceptance then 404s", async () => {
        const created = await invite("new@hire.example");
        const cancelled = await request(app)
            .delete(`/orgs/org-1/invitations/${created.body.id}`)
            .set(...AUTH);
        expect(cancelled.status).toBe(204);

        // 404, not 409: "already answered" would tell the recipient
        // something untrue — an admin withdrew the invitation; they never
        // answered it. The client's 404 copy is written for exactly this:
        // "That invitation is no longer available. It may have been
        // cancelled."
        as("new-hire", "new@hire.example");
        const res = await request(app)
            .post(`/user/invitations/${created.body.id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(404);
    });

    it("resend pushes the expiry back out", async () => {
        const created = await invite("new@hire.example");
        tables.org_invitations[0].expires_at = new Date(
            Date.now() - 1000,
        ).toISOString();
        const res = await request(app)
            .post(`/orgs/org-1/invitations/${created.body.id}/resend`)
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(new Date(res.body.expires_at).getTime()).toBeGreaterThan(
            Date.now(),
        );
    });

    it("claim-after-signup: an invitation predating the account still lands", async () => {
        await invite("future@hire.example", "member");
        // A brand-new account whose profile did not exist at invite time.
        as("brand-new", "future@hire.example");
        const mine = await request(app).get("/user/invitations").set(...AUTH);
        expect(mine.body).toHaveLength(1);
        const res = await request(app)
            .post(`/user/invitations/${mine.body[0].id}/accept`)
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(
            tables.org_members.find((m) => m.user_id === "brand-new"),
        ).toMatchObject({ org_id: "org-1", role: "member" });
    });
});

// ---------------------------------------------------------------------------
// Project organization access overrides
// ---------------------------------------------------------------------------

describe("project organization overrides over HTTP", () => {
    it("an owner assigns an organization member a chosen resource role", async () => {
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            user_id: "member-1",
            email: "member@firm.example",
            role: "viewer",
        });
        expect(tables.project_org_access_overrides).toEqual([
            expect.objectContaining({
                project_id: "proj-1",
                user_id: "member-1",
                role: "viewer",
            }),
        ]);
        expect(tables.org_members).toHaveLength(2);
    });

    it("400s an invalid role and self-sharing", async () => {
        const badRole = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "x@y.example", role: "manager" });
        expect(badRole.status).toBe(400);

        const self = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "Owner@Firm.example", role: "editor" });
        expect(self.status).toBe(400);
    });

    const addColleague = (role: "owner" | "admin") => {
        tables.org_members.push({
            id: "m-3",
            org_id: "org-1",
            user_id: "admin-2",
            role,
            created_at: "t3",
        });
        tables.user_profiles.push({
            user_id: "admin-2",
            email: "partner@firm.example",
            display_name: "Pat",
        });
    };

    it("does not allow an organization owner to be overridden on a public project", async () => {
        // An organization owner owns every public project, so there is
        // nothing to give them there and nothing that can be taken away.
        addColleague("owner");

        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "partner@firm.example", role: "deny" });

        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "Organization owners always own a public item",
        );
        expect(tables.project_org_access_overrides).toEqual([]);
    });

    it("shares a private project with an organization owner like any other member", async () => {
        // A private project is not an organization owner's by office, so
        // its creator gives them a role the way they would anyone.
        addColleague("owner");
        tables.projects[0].visibility = "private";

        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "partner@firm.example", role: "viewer" });

        expect(res.status).toBe(201);
        expect(tables.project_org_access_overrides).toEqual([
            expect.objectContaining({
                project_id: "proj-1",
                user_id: "admin-2",
                role: "viewer",
            }),
        ]);
    });

    it("walls an organization admin off a project like any other member", async () => {
        // Administering the organization gives no standing on its content.
        addColleague("admin");

        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "partner@firm.example", role: "deny" });

        expect(res.status).toBe(201);
        expect(tables.project_org_access_overrides).toEqual([
            expect.objectContaining({
                project_id: "proj-1",
                user_id: "admin-2",
                role: "deny",
            }),
        ]);
    });

    it("403s a member trying to change who has access", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "viewer" });
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only a project owner can change who has access.",
        );
    });

    it("lists explicit organization overrides for an owner", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });

        const res = await request(app)
            .get("/projects/proj-1/access")
            .set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            scope: "organization",
            org_id: "org-1",
            access_role: "owner",
        });
        expect(res.body.grants).toEqual([
            expect.objectContaining({
                email: "member@firm.example",
                role: "viewer",
            }),
        ]);
    });

    it("keeps the grant roster away from non-admins", async () => {
        // The grant list is the management surface: each row names a
        // recipient, a role and a grantor. Serving it at mere reachability
        // let a single read-only grant — the outside-counsel tier —
        // enumerate the whole team on a matter.
        as("member-1", "member@firm.example");
        const res = await request(app)
            .get("/projects/proj-1/access")
            .set(...AUTH);
        expect(res.status).toBe(403);
        expect(res.body.detail).toBe(
            "Only a project owner can change who has access.",
        );
        expect(res.body.grants).toBeUndefined();
    });

    it("shows organization members and their effective roles", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });

        as("member-1", "member@firm.example");
        const memberView = await request(app)
            .get("/projects/proj-1/people")
            .set(...AUTH);
        expect(memberView.status).toBe(200);
        expect(memberView.body.members).toEqual([
            expect.objectContaining({
                email: "member@firm.example",
                role: "viewer",
            }),
        ]);
    });

    it("removes an override, restoring the member's organization default", async () => {
        await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });

        const gone = await request(app)
            .delete("/projects/proj-1/access/member%40firm.example")
            .set(...AUTH);
        expect(gone.status).toBe(204);
        expect(tables.project_org_access_overrides).toHaveLength(0);

        const missing = await request(app)
            .delete("/projects/proj-1/access/ghost%40outside.example")
            .set(...AUTH);
        expect(missing.status).toBe(404);
    });

    it("does not let a direct grant cross into an organization project", async () => {
        const grant = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@outside.example", role: "owner" });
        expect(grant.status).toBe(400);
        expect(tables.project_access_grants).toHaveLength(0);

        as("outsider", "counsel@outside.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(404);
    });
});

// ---------------------------------------------------------------------------
// The contact fields the permission popups need
// ---------------------------------------------------------------------------

describe("GET /projects/:projectId admin contacts", () => {
    it("names the creator and the org's admins so a refusal can say who to ask", async () => {
        as("member-1", "member@firm.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(200);
        // owner_email was declared on this shape for a long time and always
        // came back null, so the UI's "ask …" line could never render.
        expect(res.body.owner_email).toBe("owner@firm.example");
        expect(res.body.owner_display_name).toBe("Ada");
        expect(res.body.admin_contacts).toEqual([
            expect.objectContaining({
                email: "owner@firm.example",
                source: "creator",
            }),
        ]);
        expect(res.body.access_role).toBe("editor");
    });
});

// ---------------------------------------------------------------------------
// Private by default, and the setting that opens a project to everyone
// ---------------------------------------------------------------------------
//
// proj-1 is seeded public. owner-1 created it and owns the organization;
// member-1 is a plain member with no override.

describe("project visibility over HTTP", () => {
    const setVisibility = (visibility: unknown) =>
        request(app)
            .patch("/projects/proj-1")
            .set(...AUTH)
            .send({ visibility });
    const peopleEmails = async () => {
        const res = await request(app)
            .get("/projects/proj-1/people")
            .set(...AUTH);
        expect(res.status).toBe(200);
        return [
            res.body.owner?.email,
            ...res.body.members.map((member: { email: string }) => member.email),
        ];
    };

    it("lets every member open a public project, and lists them on its roster", async () => {
        expect(await peopleEmails()).toEqual([
            "owner@firm.example",
            "member@firm.example",
        ]);
        as("member-1", "member@firm.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body.access_role).toBe("editor");
    });

    it("closes the project to members it was not shared with when made private", async () => {
        const res = await setVisibility("private");
        expect(res.status).toBe(200);
        expect(res.body.visibility).toBe("private");
        expect(tables.projects[0].visibility).toBe("private");

        // The roster stops claiming the member can read it...
        expect(await peopleEmails()).toEqual(["owner@firm.example"]);
        // ...because they cannot: missing, not forbidden, so its existence
        // is not confirmed either.
        as("member-1", "member@firm.example");
        const detail = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(detail.status).toBe(404);
        const people = await request(app)
            .get("/projects/proj-1/people")
            .set(...AUTH);
        expect(people.status).toBe(404);
        // Nor does it appear among the organization's projects for them.
        const resources = await request(app)
            .get("/orgs/org-1/resources")
            .set(...AUTH);
        expect(resources.body.projects).toEqual([]);
    });

    it("admits a member to a private project at the role it was shared with them", async () => {
        await setVisibility("private");
        const grant = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "member@firm.example", role: "viewer" });
        expect(grant.status).toBe(201);
        expect(await peopleEmails()).toEqual([
            "owner@firm.example",
            "member@firm.example",
        ]);

        as("member-1", "member@firm.example");
        const res = await request(app).get("/projects/proj-1").set(...AUTH);
        expect(res.status).toBe(200);
        expect(res.body.access_role).toBe("viewer");
    });

    it("cannot be shared with somebody outside the organization", async () => {
        tables.user_profiles.push({
            user_id: "outsider-1",
            email: "counsel@elsewhere.example",
            display_name: "Out",
        });
        const res = await request(app)
            .post("/projects/proj-1/access")
            .set(...AUTH)
            .send({ email: "counsel@elsewhere.example", role: "viewer" });
        expect(res.status).toBe(400);
        expect(res.body.detail).toBe(
            "Only current organization members can be assigned a role",
        );
        expect(tables.project_org_access_overrides).toEqual([]);
    });

    it("leaves who can open a project to its owners", async () => {
        as("member-1", "member@firm.example");
        const res = await setVisibility("private");
        expect(res.status).toBe(403);
        expect(tables.projects[0].visibility).toBe("organization");
    });

    it("400s a visibility that is not one of the two", async () => {
        const res = await setVisibility("everyone");
        expect(res.status).toBe(400);
        expect(tables.projects[0].visibility).toBe("organization");
    });

    it("refuses to open a personal project to an organization", async () => {
        tables.projects[0].org_id = null;
        tables.projects[0].visibility = "private";
        const res = await setVisibility("organization");
        expect(res.status).toBe(400);
        expect(tables.projects[0].visibility).toBe("private");
    });

    describe("a second organization owner, who did not create the project and was never shared it", () => {
        beforeEach(() => {
            tables.org_members.push({
                id: "m-3",
                org_id: "org-1",
                user_id: "owner-2",
                role: "owner",
                created_at: "t3",
            });
            tables.user_profiles.push({
                user_id: "owner-2",
                email: "partner@firm.example",
                display_name: "Pat",
            });
        });
        const openAsSecondOwner = async () => {
            as("owner-2", "partner@firm.example");
            const res = await request(app).get("/projects/proj-1").set(...AUTH);
            as("owner-1", "owner@firm.example");
            return res;
        };

        it("is an Owner of it while it is public", async () => {
            const res = await openAsSecondOwner();
            expect(res.status).toBe(200);
            expect(res.body.access_role).toBe("owner");
        });

        it("cannot open it once it is private", async () => {
            // Private is private: owning the organization is not a key to a
            // colleague's matter.
            await setVisibility("private");
            expect((await openAsSecondOwner()).status).toBe(404);
        });

        it("takes it over when its creator leaves and no Owner is left", async () => {
            await setVisibility("private");
            tables.org_members = tables.org_members.filter(
                (membership) => membership.user_id !== "owner-1",
            );

            const res = await openAsSecondOwner();
            expect(res.status).toBe(200);
            expect(res.body.access_role).toBe("owner");
        });

        it("does not take it over while another member is still an Owner of it", async () => {
            await setVisibility("private");
            tables.project_org_access_overrides.push({
                project_id: "proj-1",
                org_id: "org-1",
                user_id: "member-1",
                role: "owner",
            });
            tables.org_members = tables.org_members.filter(
                (membership) => membership.user_id !== "owner-1",
            );

            expect((await openAsSecondOwner()).status).toBe(404);
        });
    });
});

// ---------------------------------------------------------------------------
// Internal failures do not narrate the database to the caller
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Organization provider keys
// ---------------------------------------------------------------------------

describe("organization provider keys", () => {
    const SECRET = "sk-org-secret-value";
    // Keys exported in the developer's shell (or CI) sit under every owner;
    // these cases are about the organization's and the member's.
    const ENV_KEYS = ["OPENAI_API_KEY", "MISTRAL_API_KEY"];
    const savedEnv: Record<string, string | undefined> = {};

    afterEach(() => {
        for (const name of ENV_KEYS) {
            if (savedEnv[name] === undefined) delete process.env[name];
            else process.env[name] = savedEnv[name];
        }
    });

    beforeEach(() => {
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = "test-secret";
        for (const name of ENV_KEYS) {
            savedEnv[name] = process.env[name];
            delete process.env[name];
        }
        tables.organizations[0].allow_personal_api_keys = true;
        tables.org_api_keys = [];
        tables.user_api_keys = [];
        tables.org_router_models = [];
        tables.user_router_models = [];
        tables.org_members.push({
            id: "m-3",
            org_id: "org-1",
            user_id: "admin-1",
            role: "admin",
            created_at: "t3",
        });
    });

    const saveKey = (provider = "openai", body: object = { api_key: SECRET }) =>
        request(app)
            .put(`/orgs/org-1/api-keys/${provider}`)
            .set(...AUTH)
            .send(body);

    it("lets an owner save a key and never sends it back", async () => {
        const res = await saveKey();

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            keys: { openai: true, sources: { openai: "org" } },
            effective: { openai: true, sources: { openai: "org" } },
            allow_personal_api_keys: true,
            can_manage: true,
        });
        expect(JSON.stringify(res.body)).not.toContain(SECRET);
        expect(tables.org_api_keys).toHaveLength(1);
        expect(tables.org_api_keys[0]).toMatchObject({
            org_id: "org-1",
            provider: "openai",
            updated_by: "owner-1",
        });
        // Encrypted at rest, and absent from the audit trail.
        expect(JSON.stringify(tables.org_api_keys)).not.toContain(SECRET);
        expect(JSON.stringify(tables.audit_events)).not.toContain(SECRET);
        expect(tables.audit_events).toEqual([
            expect.objectContaining({ action: "org.api_key.saved" }),
        ]);
    });

    it("lets an admin manage keys too", async () => {
        as("admin-1", "admin@firm.example");
        expect((await saveKey()).status).toBe(200);
    });

    it("refuses a plain member, on every write", async () => {
        as("member-1", "member@firm.example");

        expect((await saveKey()).status).toBe(403);
        expect(
            (
                await request(app)
                    .patch("/orgs/org-1/api-keys/openai")
                    .set(...AUTH)
                    .send({ enabled: false })
            ).status,
        ).toBe(403);
        expect(
            (
                await request(app)
                    .put("/orgs/org-1/api-keys/policy")
                    .set(...AUTH)
                    .send({ allow_personal_api_keys: false })
            ).status,
        ).toBe(403);
        expect(tables.org_api_keys).toEqual([]);
        expect(tables.organizations[0].allow_personal_api_keys).toBe(true);
        expect(tables.audit_events).toEqual([]);
    });

    it("shows a member what is set up, without the right to change it", async () => {
        await saveKey();
        as("member-1", "member@firm.example");

        const res = await request(app).get("/orgs/org-1/api-keys").set(...AUTH);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            keys: { openai: true },
            effective: { openai: true, sources: { openai: "org" } },
            can_manage: false,
        });
        expect(JSON.stringify(res.body)).not.toContain(SECRET);
    });

    it("hides the organization from somebody outside it", async () => {
        await saveKey();
        as("stranger-1", "stranger@elsewhere.example");

        expect(
            (await request(app).get("/orgs/org-1/api-keys").set(...AUTH)).status,
        ).toBe(404);
        expect((await saveKey("claude")).status).toBe(404);
        expect(tables.org_api_keys).toHaveLength(1);
    });

    it("removes the key when saved empty", async () => {
        await saveKey();

        const res = await saveKey("openai", { api_key: null });

        expect(res.status).toBe(200);
        expect(res.body.keys.openai).toBe(false);
        expect(tables.org_api_keys).toEqual([]);
        expect(tables.audit_events.map((event) => event.action)).toEqual([
            "org.api_key.saved",
            "org.api_key.removed",
        ]);
    });

    it("turns a provider off and on without losing the key", async () => {
        await saveKey();

        const off = await request(app)
            .patch("/orgs/org-1/api-keys/openai")
            .set(...AUTH)
            .send({ enabled: false });
        expect(off.status).toBe(200);
        expect(off.body).toMatchObject({
            keys: { openai: false, enabled: { openai: false } },
            effective: { openai: false },
        });
        expect(tables.org_api_keys).toHaveLength(1);

        const on = await request(app)
            .patch("/orgs/org-1/api-keys/openai")
            .set(...AUTH)
            .send({ enabled: true });
        expect(on.body).toMatchObject({ keys: { openai: true } });
        expect(tables.audit_events.map((event) => event.action)).toEqual([
            "org.api_key.saved",
            "org.api_key.disabled",
            "org.api_key.enabled",
        ]);
    });

    it("cannot switch a provider the organization has no key for", async () => {
        const res = await request(app)
            .patch("/orgs/org-1/api-keys/openai")
            .set(...AUTH)
            .send({ enabled: false });
        expect(res.status).toBe(409);
    });

    it("rejects an unknown provider and a malformed body", async () => {
        expect((await saveKey("not-a-provider")).status).toBe(400);
        expect(
            (
                await request(app)
                    .patch("/orgs/org-1/api-keys/openai")
                    .set(...AUTH)
                    .send({ enabled: "no" })
            ).status,
        ).toBe(400);
        expect(
            (
                await request(app)
                    .put("/orgs/org-1/api-keys/policy")
                    .set(...AUTH)
                    .send({ allow_personal_api_keys: "no" })
            ).status,
        ).toBe(400);
    });

    it("reads \"policy\" as the setting, not as a provider", async () => {
        const res = await request(app)
            .put("/orgs/org-1/api-keys/policy")
            .set(...AUTH)
            .send({ allow_personal_api_keys: false });

        expect(res.status).toBe(200);
        expect(res.body.allow_personal_api_keys).toBe(false);
        expect(tables.organizations[0].allow_personal_api_keys).toBe(false);
        expect(tables.audit_events).toEqual([
            expect.objectContaining({ action: "org.personal_api_keys.blocked" }),
        ]);
    });

    it("takes a member's own key out of play once personal keys are blocked", async () => {
        // The member has saved a key of their own for a provider the
        // organization has none for.
        tables.user_api_keys.push({
            user_id: "member-1",
            provider: "mistral",
            enabled: true,
            settings: {},
        });
        const asMember = async () => {
            as("member-1", "member@firm.example");
            const res = await request(app)
                .get("/orgs/org-1/api-keys")
                .set(...AUTH);
            as("owner-1", "owner@firm.example");
            return res.body.effective;
        };

        expect(await asMember()).toMatchObject({
            mistral: true,
            sources: { mistral: "user" },
        });

        await request(app)
            .put("/orgs/org-1/api-keys/policy")
            .set(...AUTH)
            .send({ allow_personal_api_keys: false });

        expect(await asMember()).toMatchObject({
            mistral: false,
            sources: { mistral: null },
        });
    });

    // -- The models an organization's key may run ---------------------------

    const saveModels = (provider: string, model_ids: unknown) =>
        request(app)
            .put(`/orgs/org-1/api-keys/${provider}/models`)
            .set(...AUTH)
            .send({ model_ids });

    it("lets an admin choose the models the organization's key may run", async () => {
        await saveKey("openrouter");
        as("admin-1", "admin@firm.example");

        const res = await saveModels("openrouter", [
            "anthropic/claude-sonnet-5",
            "openai/gpt-6",
        ]);

        expect(res.status).toBe(200);
        expect(res.body.router_models.openrouter).toEqual([
            "anthropic/claude-sonnet-5",
            "openai/gpt-6",
        ]);
        expect(tables.org_router_models).toHaveLength(2);
        expect(tables.audit_events.at(-1)).toMatchObject({
            action: "org.router_models.updated",
        });
    });

    it("gives every member the organization's list for a provider whose key it holds", async () => {
        await saveKey("openrouter");
        await saveModels("openrouter", ["firm/approved"]);
        // The member saved their own lists long ago.
        tables.user_router_models.push(
            { user_id: "member-1", router: "openrouter", model_id: "mine/own" },
            { user_id: "member-1", router: "vercel", model_id: "mine/vercel" },
        );
        as("member-1", "member@firm.example");

        const res = await request(app).get("/orgs/org-1/api-keys").set(...AUTH);

        expect(res.body.effective_router_models.openrouter).toEqual([
            "firm/approved",
        ]);
        // The organization has no Vercel key, so the member's list stands.
        expect(res.body.effective_router_models.vercel).toEqual(["mine/vercel"]);
    });

    it("replaces the whole list, and clears it when sent empty", async () => {
        await saveModels("bedrock", ["us.anthropic.claude-opus-5-5"]);
        await saveModels("bedrock", ["us.anthropic.claude-sonnet-5-5"]);
        expect(
            tables.org_router_models.map((row) => row.model_id),
        ).toEqual(["us.anthropic.claude-sonnet-5-5"]);

        const res = await saveModels("bedrock", []);
        expect(res.status).toBe(200);
        expect(tables.org_router_models).toEqual([]);
    });

    it("refuses a plain member and an outsider", async () => {
        as("member-1", "member@firm.example");
        expect((await saveModels("openrouter", ["a/b"])).status).toBe(403);
        as("stranger-1", "stranger@elsewhere.example");
        expect((await saveModels("openrouter", ["a/b"])).status).toBe(404);
        expect(tables.org_router_models).toEqual([]);
    });

    it("rejects a bad list as a whole rather than saving part of it", async () => {
        expect((await saveModels("openrouter", "a/b")).status).toBe(400);
        expect(
            (await saveModels("openrouter", ["a/b", "has space/model"])).status,
        ).toBe(400);
        expect((await saveModels("openrouter", ["a/b", "a/b"])).status).toBe(400);
        expect(
            (
                await saveModels(
                    "openrouter",
                    Array.from({ length: 51 }, (_, index) => `vendor/m${index}`),
                )
            ).status,
        ).toBe(400);
        // A provider that keeps no model list.
        expect((await saveModels("claude", ["a/b"])).status).toBe(400);
        expect(tables.org_router_models).toEqual([]);
        expect(tables.audit_events).toEqual([]);
    });

    it("reports a failed save without leaking the database's message", async () => {
        writeErrors.org_router_models = { message: "relation exploded" };

        const res = await saveModels("openrouter", ["a/b"]);

        expect(res.status).toBe(500);
        expect(JSON.stringify(res.body)).not.toContain("exploded");
        expect(tables.audit_events).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Organization logo
// ---------------------------------------------------------------------------

describe("organization logo", () => {
    // The smallest things that are really each format: the signature a file
    // of that type begins with, and a little after it.
    const dataUrl = (type: string, bytes: number[]) =>
        `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    const PNG = dataUrl(
        "image/png",
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4],
    );
    const JPEG = dataUrl("image/jpeg", [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const WEBP = dataUrl(
        "image/webp",
        [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP"), 1, 2],
    );

    beforeEach(() => {
        tables.org_logos = [];
        tables.org_members.push({
            id: "m-3",
            org_id: "org-1",
            user_id: "admin-1",
            role: "admin",
            created_at: "t3",
        });
    });

    const putLogo = (data_url: unknown) =>
        request(app).put("/orgs/org-1/logo").set(...AUTH).send({ data_url });
    const getLogo = () => request(app).get("/orgs/org-1/logo").set(...AUTH);

    it("has none until one is set", async () => {
        expect((await getLogo()).status).toBe(404);
    });

    it.each([
        ["PNG", PNG, "image/png"],
        ["JPEG", JPEG, "image/jpeg"],
        ["WebP", WEBP, "image/webp"],
    ])("lets an owner set a %s logo, and every member read it back", async (_name, image, type) => {
        const saved = await putLogo(image);

        expect(saved.status).toBe(200);
        expect(typeof saved.body.logo_updated_at).toBe("string");
        expect(tables.org_logos).toEqual([
            expect.objectContaining({
                org_id: "org-1",
                content_type: type,
                updated_by: "owner-1",
            }),
        ]);
        expect(tables.audit_events).toEqual([
            expect.objectContaining({ action: "org.logo.updated" }),
        ]);
        // The image is not written into the audit trail.
        expect(JSON.stringify(tables.audit_events)).not.toContain(
            image.split(",")[1],
        );

        as("member-1", "member@firm.example");
        const read = await getLogo();
        expect(read.status).toBe(200);
        expect(read.body.data_url).toBe(image);
    });

    it("lets an admin set it too, and replaces rather than adds", async () => {
        await putLogo(PNG);
        as("admin-1", "admin@firm.example");

        expect((await putLogo(JPEG)).status).toBe(200);

        expect(tables.org_logos).toHaveLength(1);
        expect(tables.org_logos[0]).toMatchObject({
            content_type: "image/jpeg",
            updated_by: "admin-1",
        });
    });

    it("refuses a plain member and hides the organization from an outsider", async () => {
        as("member-1", "member@firm.example");
        expect((await putLogo(PNG)).status).toBe(403);
        expect(
            (await request(app).delete("/orgs/org-1/logo").set(...AUTH)).status,
        ).toBe(403);

        as("stranger-1", "stranger@elsewhere.example");
        expect((await putLogo(PNG)).status).toBe(404);
        expect((await getLogo()).status).toBe(404);
        expect(tables.org_logos).toEqual([]);
    });

    it("accepts only a real PNG, JPEG or WebP", async () => {
        const svg = `data:image/svg+xml;base64,${Buffer.from(
            "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
        ).toString("base64")}`;
        // Says PNG; is not one.
        const disguised = dataUrl("image/png", [...Buffer.from("<svg onload=alert(1)>")]);

        for (const image of [
            svg,
            disguised,
            "data:image/png;base64,",
            "https://example.com/logo.png",
            "not a data url",
            undefined,
            42,
        ]) {
            const res = await putLogo(image);
            expect([image, res.status]).toEqual([image, 400]);
        }
        expect(tables.org_logos).toEqual([]);
        expect(tables.audit_events).toEqual([]);
    });

    it("refuses an image over the size an organization may store", async () => {
        const big = dataUrl("image/png", [
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ...new Array(512 * 1024).fill(7),
        ]);

        const res = await putLogo(big);

        expect(res.status).toBe(400);
        expect(res.body.detail).toMatch(/too large/);
        expect(tables.org_logos).toEqual([]);
    });

    it("removes the logo, and says nothing in the audit trail when there was none", async () => {
        await putLogo(PNG);

        const removed = await request(app)
            .delete("/orgs/org-1/logo")
            .set(...AUTH);
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual({ logo_updated_at: null });
        expect(tables.org_logos).toEqual([]);
        expect((await getLogo()).status).toBe(404);

        const again = await request(app)
            .delete("/orgs/org-1/logo")
            .set(...AUTH);
        expect(again.status).toBe(200);
        expect(tables.audit_events.map((event) => event.action)).toEqual([
            "org.logo.updated",
            "org.logo.removed",
        ]);
    });
});

describe("sendOrgFailure db_error", () => {
    it("answers a generic 500 instead of forwarding the Postgres message", async () => {
        const consoleError = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        as("owner-1", "owner@firm.example");
        // A realistic Postgres error: it names the schema, the table, the
        // constraint, and quotes the offending row — which in the org tables
        // is somebody's email address.
        writeErrors.organizations = {
            code: "23505",
            message:
                'duplicate key value violates unique constraint "org_invitations_active_unique" ' +
                "DETAIL: Key (org_id, email)=(org-1, partner@firm.example) already exists.",
        };

        const res = await request(app)
            .patch("/orgs/org-1")
            .set(...AUTH)
            .send({ name: "Acme Renamed" });

        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({
            code: "internal_error",
            detail: "Something went wrong. Please try again.",
        });
        const body = JSON.stringify(res.body);
        expect(body).not.toContain("org_invitations_active_unique");
        expect(body).not.toContain("partner@firm.example");
        expect(body).not.toContain("duplicate key");

        // The body above is generic either way, because
        // middleware/internalErrorResponse.ts rewrites EVERY >=500 JSON body
        // as a last line of defence. What this pins is that the router no
        // longer needs saving: the handler itself reports the failure through
        // sendInternalError, so the log is a plain internal error rather than
        // the sanitizer's "I just caught a route leaking" record.
        const tags = consoleError.mock.calls.map(([tag]) => tag);
        expect(tags).toContain("[http/internal-error]");
        expect(tags).not.toContain("[http/sanitized-internal-error]");
        consoleError.mockRestore();
    });

    it("still answers intentional 4xx verdicts with their own copy", async () => {
        as("owner-1", "owner@firm.example");
        // The last-owner invariant is a decision, not an incident: the caller
        // caused it and needs to be told what it was.
        const res = await request(app)
            .delete("/orgs/org-1/members/owner-1")
            .set(...AUTH);
        expect(res.status).toBe(409);
        expect(res.body.detail).toBe(
            "An organization must keep at least one owner.",
        );
    });
});
