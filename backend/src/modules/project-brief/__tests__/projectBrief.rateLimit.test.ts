import request from "supertest";
import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => {
    process.env.RATE_LIMIT_CHAT_MAX = "2";
    process.env.RATE_LIMIT_GENERAL_MAX = "1000";
    return { generate: vi.fn(async () => ({ ok: true, data: { id: "fictional-proposal" } })) };
});
vi.mock("../projectBrief.service", () => ({
    resumeBrief: vi.fn(), designateBrief: vi.fn(), proposeBrief: calls.generate,
    getBriefProposal: vi.fn(), applyBrief: vi.fn(), readBriefSource: vi.fn(),
}));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../../../middleware/auth", () => ({
    requireAuth: (_req: unknown, res: {locals: Record<string, unknown>}, next: () => void) => { res.locals.userId = "fictional-actor"; next(); },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import { app } from "../../../app";
it("uses the existing model-request allowance and rejects the next proposal without generation", async () => {
    const endpoint = "/projects/40000000-0000-4000-8000-000000000001/brief/proposals";
    const body = { sourceIds: ["40000000-0000-4000-8000-000000000002"], model: "mock", confirmProvider: true };
    expect((await request(app).post(endpoint).send(body)).status).toBe(201);
    expect((await request(app).post(endpoint).send(body)).status).toBe(201);
    const limited = await request(app).post(endpoint).send(body);
    expect(limited.status).toBe(429);
    expect(calls.generate).toHaveBeenCalledTimes(2);
});
