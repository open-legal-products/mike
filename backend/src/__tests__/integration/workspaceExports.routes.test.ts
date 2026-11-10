import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

// Settings > Privacy & Data exports cover one workspace, named by
// params.workspace: Personal unless it names an organization the caller
// belongs to, and there only once its owners allow members to export.

const ORG_ID = "11111111-1111-4111-8111-111111111111";

const state = vi.hoisted(() => {
    process.env.RATE_LIMIT_EXPORT_MAX = "1000";
    process.env.RATE_LIMIT_GENERAL_MAX = "1000";
    return {
        insertedJobs: [] as Record<string, unknown>[],
        membership: null as { org_id: string; role: string } | null,
        organization: { kind: "team", allow_member_exports: false } as Record<
            string,
            unknown
        >,
    };
});

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "update", "delete", "eq", "in", "is", "lt", "limit", "order"])
        q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: Record<string, unknown>) => {
        if (table === "db_jobs") state.insertedJobs.push(payload);
        return q;
    });
    const result = () =>
        table === "db_jobs"
            ? { data: { id: "job-1" }, error: null }
            : table === "org_members"
              ? { data: state.membership, error: null }
              : table === "organizations"
                ? { data: state.organization, error: null }
                : { data: null, error: null };
    q.single = vi.fn(() => Promise.resolve(result()));
    q.maybeSingle = vi.fn(() => Promise.resolve(result()));
    q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
    return q;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(async () => ({ data: null, error: null })),
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../../lib/dbq/runner", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    dbJobsEnabled: () => true,
}));

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;
const lastJob = () => state.insertedJobs.at(-1) as {
    payload: Record<string, unknown>;
    dedupe_key: string | null;
};

beforeEach(() => {
    state.insertedJobs.length = 0;
    state.membership = null;
    state.organization = { kind: "team", allow_member_exports: false };
});

describe("workspace exports", () => {
    it.each(["account", "chats", "tabular-reviews", "memory-zip"])(
        "%s covers Personal when no workspace is named",
        async (type) => {
            const res = await request(app).post("/user/exports").set(...AUTH).send({ type });

            expect(res.status).toBe(202);
            expect(lastJob().payload.orgId).toBeNull();
            expect(lastJob().dedupe_key).toBe(`export:u1:${type}:personal`);
        },
    );

    it("covers an organization whose owners allow members to export", async () => {
        state.membership = { org_id: ORG_ID, role: "member" };
        state.organization = { kind: "team", allow_member_exports: true };

        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "chats", params: { workspace: ORG_ID } });

        expect(res.status).toBe(202);
        expect(lastJob().payload.orgId).toBe(ORG_ID);
        // Its own artifact: not merged with the Personal export.
        expect(lastJob().dedupe_key).toBe(`export:u1:chats:${ORG_ID}`);
    });

    it("refuses a member when the organization has not allowed exports", async () => {
        state.membership = { org_id: ORG_ID, role: "admin" };

        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "account", params: { workspace: ORG_ID } });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe("member_data_action_disabled");
        expect(state.insertedJobs).toHaveLength(0);
    });

    it("lets an owner export whatever the organization allows members", async () => {
        state.membership = { org_id: ORG_ID, role: "owner" };

        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "memory-zip", params: { workspace: ORG_ID } });

        expect(res.status).toBe(202);
        expect(lastJob().payload.orgId).toBe(ORG_ID);
    });

    it("answers a workspace the caller is not in as not found", async () => {
        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "account", params: { workspace: ORG_ID } });

        expect(res.status).toBe(404);
        expect(res.body.code).toBe("workspace_not_found");
        expect(state.insertedJobs).toHaveLength(0);
    });

    it("leaves the document and audit exports as they were", async () => {
        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "documents-zip", params: { document_ids: ["d1"], workspace: ORG_ID } });

        expect(res.status).toBe(202);
        expect(lastJob().payload).not.toHaveProperty("orgId");
    });
});
