import { describe, it, expect, vi } from "vitest";
import request from "supertest";

// Small enough to exhaust with one request to each share path.
vi.hoisted(() => { process.env.RATE_LIMIT_DIRECT_SHARE_MAX = "5"; });

// The limiter runs before each handler and counts every attempt, whatever the
// handler answers, so the database only has to let the handlers finish.
vi.mock("../../lib/supabase", async () => {
    const { mockSupabase } = await import("../helpers/supabaseMock.js");
    return { createServerSupabase: vi.fn(() => mockSupabase()) };
});

// Authenticates whoever the X-Test-User header names.
vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        req: { headers: Record<string, string | undefined> },
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        const userId = req.headers["x-test-user"] ?? "u1";
        res.locals.userId = userId;
        res.locals.userEmail = `${userId}@test.local`;
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

import { app } from "../../app";

const ID = "11111111-1111-4111-8111-111111111111";
const SHARE_PATHS = [
    `/projects/${ID}/access`,
    `/chat/${ID}/access`,
    `/tabular-review/${ID}/access`,
    `/workflows/${ID}/share`,
    `/playbooks/${ID}/share`,
];

function share(caller: string, path: string) {
    return request(app)
        .post(path)
        .set("Authorization", "Bearer test")
        .set("X-Test-User", caller)
        .send({ email: "someone@example.com", emails: ["someone@example.com"], role: "viewer" });
}

describe("direct-share rate limit", () => {
    it("caps each user's share attempts across every share path, not each IP", async () => {
        for (const path of SHARE_PATHS) {
            expect((await share("prober", path)).status).not.toBe(429);
        }

        const limited = await share("prober", SHARE_PATHS[0]);
        expect(limited.status).toBe(429);
        expect(limited.body.code).toBe("rate_limited");

        // Another user behind the same address still has their own budget.
        expect((await share("colleague", SHARE_PATHS[0])).status).not.toBe(429);
    });

    it("counts every address in an emails array against the same budget", async () => {
        const batch = (caller: string, count: number) =>
            request(app)
                .post(`/workflows/${ID}/share`)
                .set("Authorization", "Bearer test")
                .set("X-Test-User", caller)
                .send({
                    emails: Array.from({ length: count }, (_, i) => `p${i}@example.com`),
                    role: "viewer",
                });

        // Five addresses spend the whole budget of five in one request...
        expect((await batch("batcher", 5)).status).not.toBe(429);
        // ...so the next request is refused, however few it carries.
        const limited = await batch("batcher", 1);
        expect(limited.status).toBe(429);
        expect(limited.body.code).toBe("rate_limited");

        // A request carrying more addresses than the budget is refused outright.
        const oversized = await batch("bulk", 6);
        expect(oversized.status).toBe(429);
        expect(oversized.body.code).toBe("rate_limited");
    });
});
