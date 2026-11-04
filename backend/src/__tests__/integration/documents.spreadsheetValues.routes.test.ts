import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
const mock = vi.hoisted(() => ({ preview: vi.fn(), source: vi.fn() }));
vi.mock("../../modules/documents/documents.service", async original => ({
    ...await original<typeof import("../../modules/documents/documents.service")>(),
    getSpreadsheetValuesPreview: mock.preview, getSpreadsheetValuesSource: mock.source,
}));
vi.mock("../../middleware/auth", () => ({ requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers.authorization !== "Bearer synthetic") { res.sendStatus(401); return; }
    res.locals.userId = "synthetic-reader"; res.locals.userEmail = "reader@example.test"; next();
} }));
vi.mock("../../lib/supabase", () => ({ createServerSupabase: () => ({}) }));
import { documentsRouter } from "../../modules/documents/documents.routes";
const app = express(); app.use("/single-documents", documentsRouter);
const path = "/single-documents/10000000-0000-4000-8000-000000000001/spreadsheet-preview";
const versionId = "20000000-0000-4000-8000-000000000001", hash = "a".repeat(64);
beforeEach(() => {
    vi.clearAllMocks();
    mock.preview.mockResolvedValue({ ok: true, data: { source: { versionId, sha256: hash }, values: { sheets: [] } } });
    mock.source.mockResolvedValue({ ok: true, data: { bytes: Uint8Array.from([1, 2, 3]).buffer, filename: "Original.xls" } });
});
describe("spreadsheet preview HTTP contract", () => {
    it("requires authentication before service work", async () => {
        expect((await request(app).get(path)).status).toBe(401);
        expect(mock.preview).not.toHaveBeenCalled();
    });
    it("passes explicit historical checkpoint and uses private/no-store", async () => {
        const response = await request(app).get(path).query({ version_id: versionId }).auth("synthetic", { type: "bearer" });
        expect(response.status).toBe(200);
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(mock.preview.mock.calls[0][1]).toMatchObject({ versionId, userId: "synthetic-reader" });
    });
    it.each([
        "?version_id=a&version_id=b", "?version_id[x]=a", "?version_id=a&version_id[]=b",
        "?sha256=unexpected", "/source?version_id=x", "/source?version_id=x&sha256=a&sha256=b",
        "/source?version_id[x]=a&sha256=b", "/source?version_id=a&sha256[x]=b",
    ])("rejects ambiguous checkpoint %s", async suffix => {
        const response = await request(app).get(path + suffix).auth("synthetic", { type: "bearer" });
        expect(response.status).toBe(400);
        expect(mock.preview).not.toHaveBeenCalled(); expect(mock.source).not.toHaveBeenCalled();
    });
    it.each([
        ["not_found", undefined, 404], ["conflict", "spreadsheet_values_changed", 409],
        ["validation", "spreadsheet_values_limit", 413], ["validation", "spreadsheet_values_malformed", 400],
        ["unavailable", "spreadsheet_values_busy", 503],
    ])("maps %s/%s to %s", async (kind, code, status) => {
        mock.preview.mockResolvedValue({ ok: false, kind, code, detail: "Static test message" });
        expect((await request(app).get(path).auth("synthetic", { type: "bearer" })).status).toBe(status);
    });
    it("does not expose unexpected source diagnostics", async () => {
        mock.preview.mockResolvedValue({ ok: false, kind: "error", error: new Error("fictional private filename and content") });
        const response = await request(app).get(path).auth("synthetic", { type: "bearer" });
        expect(response.status).toBe(500); expect(response.text).not.toContain("fictional private");
    });
    it("downloads only through the exact returned checkpoint", async () => {
        const response = await request(app).get(path + "/source").query({ version_id: versionId, sha256: hash }).auth("synthetic", { type: "bearer" });
        expect(response.status).toBe(200);
        expect(response.headers["content-disposition"]).toContain("Original.xls");
        expect(response.headers["cache-control"]).toBe("private, no-store");
        expect(response.body).toEqual(Buffer.from([1, 2, 3]));
        expect(mock.source.mock.calls[0][1]).toMatchObject({ versionId, sha256: hash });
    });
});
