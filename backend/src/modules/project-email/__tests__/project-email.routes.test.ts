import express from "express";
import request from "supertest";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ authorized: true, preview: vi.fn(), import: vi.fn(), receipt: vi.fn(), latest: vi.fn() }));
vi.mock("../../../middleware/auth", () => ({ requireAuth: (_req: express.Request, res: express.Response, next: express.NextFunction) => { if (!mocks.authorized) return res.status(401).json({ detail: "Sign in." }); res.locals.userId = "actor"; res.locals.userEmail = "fixture@example.invalid"; next(); } }));
vi.mock("../../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
vi.mock("../project-email.service", () => ({ previewProjectEmail: mocks.preview, importProjectEmail: mocks.import, getProjectEmailReceipt: mocks.receipt, latestProjectEmail: mocks.latest }));
import { projectEmailRouter } from "../project-email.routes";
const app = express(); app.use(express.json()); app.use("/project-email", projectEmailRouter);
const project = "00000000-0000-4000-8000-000000000001", preview = "00000000-0000-4000-8000-000000000002";
beforeEach(() => { vi.clearAllMocks(); mocks.authorized = true; mocks.preview.mockResolvedValue({ ok: true, data: { id: preview } }); mocks.import.mockResolvedValue({ ok: true, data: { previewId: preview } }); });
it("requires authentication before reading provider metadata", async () => {
  mocks.authorized = false;
  expect((await request(app).post(`/project-email/${project}/preview`).send({ query: "fixture" })).status).toBe(401);
  expect(mocks.preview).not.toHaveBeenCalled();
});
it.each([{ selectedIds: ["m1"] }, { selectedIds: ["m1"], shareWithProject: false }, { selectedIds: ["../m1"], shareWithProject: true }, { selectedIds: ["m1"], shareWithProject: true, accountId: "foreign" }])("refuses missing consent, invalid IDs and caller-supplied identity fields", async body => {
  expect((await request(app).post(`/project-email/${project}/${preview}/import`).send(body)).status).toBe(400);
  expect(mocks.import).not.toHaveBeenCalled();
});
it("passes actor identity from the session and only the exact confirmation to the service", async () => {
  expect((await request(app).post(`/project-email/${project}/${preview}/import`).send({ selectedIds: ["m1"], shareWithProject: true })).status).toBe(200);
  expect(mocks.import).toHaveBeenCalledWith({}, { userId: "actor", userEmail: "fixture@example.invalid", projectId: project }, preview, ["m1"]);
});
it("maps an intentional authorization refusal without exposing private provider metadata", async () => {
  mocks.preview.mockResolvedValue({ ok: false, kind: "not_found", detail: "Project not found." });
  const result = await request(app).post(`/project-email/${project}/preview`).send({ query: "fixture" });
  expect(result.status).toBe(404); expect(result.body).toEqual({ detail: "Project not found." });
});
