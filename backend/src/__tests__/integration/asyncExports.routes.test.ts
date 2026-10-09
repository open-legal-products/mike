import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// The async export surface: POST /user/exports (schedule) + GET
// /user/exports/:id (poll). Two invariants are baselined here.
//
// 1. RATE LIMITING. An export is the most expensive read the API offers — it
//    walks a user's whole corpus — so the async POST that schedules one sits
//    behind exportLimiter (10/hour), the budget the synchronous project
//    export also uses. Its POLL,
//    however, must NOT: a client polls every couple of seconds while one
//    export builds, so putting the poll under a 10/hour budget would 429 the
//    user out of their own (successfully scheduled) export.
//
// 2. NO-RUNNER TOPOLOGIES. With DB_JOBS_ENABLED=false nothing drains db_jobs.
//    A 202 there is a lie that also wedges the dedupe key forever, so the
//    route must refuse instead.
//
// Env is set inside vi.hoisted so it lands before app.ts reads it at import.
// ---------------------------------------------------------------------------
const { insertedJobs, dbJobsEnabled } = vi.hoisted(() => {
    // 3, not 2: the no-runner test below spends one before the budget test.
    process.env.RATE_LIMIT_EXPORT_MAX = "3";
    process.env.RATE_LIMIT_EXPORT_WINDOW_HOURS = "1";
    process.env.RATE_LIMIT_GENERAL_MAX = "500";
    return { insertedJobs: [] as unknown[], dbJobsEnabled: vi.fn(() => true) };
});

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    for (const m of [
        "select",
        "update",
        "delete",
        "eq",
        "in",
        "is",
        "lt",
        "limit",
        "order",
    ])
        q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: unknown) => {
        if (table === "db_jobs") insertedJobs.push(payload);
        return q;
    });
    const result =
        table === "db_jobs"
            ? { data: { id: "job-1" }, error: null }
            : { data: null, error: null };
    q.single = vi.fn(() => Promise.resolve(result));
    q.maybeSingle = vi.fn(() => Promise.resolve(result));
    q.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve(result).then(resolve);
    return q;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(async () => ({ data: null, error: null })),
        auth: {
            getUser: async () => ({ data: { user: { id: "u1" } }, error: null }),
            admin: { deleteUser: vi.fn(async () => ({ error: null })) },
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
        res.locals.token = "test-token";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

vi.mock("../../lib/dbq/runner", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, dbJobsEnabled: () => dbJobsEnabled() };
});

import { app } from "../../app";

const AUTH = ["Authorization", "Bearer test"] as const;

describe("async exports", () => {
    beforeEach(() => {
        insertedJobs.length = 0;
        dbJobsEnabled.mockReturnValue(true);
    });

    it("refuses to schedule when no runner will drain the queue", async () => {
        dbJobsEnabled.mockReturnValue(false);

        const res = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "documents-zip", params: { document_ids: ["d1"] } });

        // A 202 here would be a receipt for work that cannot happen, and the
        // pending row would hold the dedupe key forever — locking the user out
        // of that export permanently, even after the runner comes back.
        expect(res.status).toBe(503);
        expect(insertedJobs).toHaveLength(0);
    });

    it("POST /user/exports is under the export budget; the poll is not", async () => {
        // The budget is 3/hour for this suite; one was spent above.
        const first = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "account" });
        expect(first.status).toBe(202);
        const second = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "account" });
        expect(second.status).toBe(202);

        const third = await request(app)
            .post("/user/exports")
            .set(...AUTH)
            .send({ type: "account" });
        expect(third.status).toBe(429);

        // Polling an export must stay usable after the POST budget is spent —
        // otherwise a user who scheduled an export cannot watch it finish.
        for (let i = 0; i < 5; i++) {
            const poll = await request(app)
                .get("/user/exports/job-1")
                .set(...AUTH);
            expect(poll.status).not.toBe(429);
        }
    });
});
