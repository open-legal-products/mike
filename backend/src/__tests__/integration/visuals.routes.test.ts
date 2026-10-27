import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exportVisual: vi.fn(),
  createDocxFromVisual: vi.fn(),
  visualSnapshot: vi.fn(),
  visualExportCapabilities: vi.fn(async () => ({ pdf: true, docx: true })),
}));

vi.mock("../../middleware/auth", () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.userId = "user-1";
    res.locals.userEmail = "user@example.com";
    next();
  },
}));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: vi.fn(() => ({})) }));
vi.mock("../../modules/visuals/visuals.service", () => mocks);

import { visualsRouter } from "../../modules/visuals/visuals.routes";

const app = express();
app.use(express.json());
app.use("/visuals", visualsRouter);

beforeEach(() => vi.clearAllMocks());

describe("visual export routes", () => {
  it("sends the rendered pdf as a download", async () => {
    mocks.exportVisual.mockResolvedValue({ ok: true, data: { bytes: Buffer.from("pdf-bytes"), filename: "Lease map.pdf" } });

    const response = await request(app).get("/visuals/doc-1/export?version_id=v2");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/pdf");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(mocks.exportVisual).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ documentId: "doc-1", versionId: "v2", userId: "user-1" }));
  });

  it("maps render failures onto their status codes", async () => {
    const detail = "x";
    const cases = [
      [{ ok: false, kind: "unavailable", detail, code: "render_timeout" }, 504],
      [{ ok: false, kind: "validation", detail, code: "render_failed" }, 422],
      [{ ok: false, kind: "unavailable", detail, code: "render_busy" }, 503],
      [{ ok: false, kind: "not_found", detail }, 404],
    ] as const;
    for (const [failure, status] of cases) {
      mocks.exportVisual.mockResolvedValueOnce(failure);
      const response = await request(app).get("/visuals/doc-1/export");
      expect(response.status).toBe(status);
      expect(response.body.detail).toBe(detail);
    }
  });

  it("saves the visual as a word document beside it", async () => {
    const created = { document_id: "doc-2", version_id: "v1", filename: "Lease map.docx" };
    mocks.createDocxFromVisual.mockResolvedValueOnce({ ok: true, data: created });

    const response = await request(app).post("/visuals/doc-1/docx").send({ version_id: "v2" });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(created);
    expect(mocks.createDocxFromVisual).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ documentId: "doc-1", versionId: "v2", userId: "user-1" }));

    mocks.createDocxFromVisual.mockResolvedValueOnce({ ok: false, kind: "forbidden", detail: "no" });
    expect((await request(app).post("/visuals/doc-1/docx").send({})).status).toBe(403);
  });
});
