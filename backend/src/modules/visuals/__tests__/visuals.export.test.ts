import { beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { serializeVisual } from "../../../lib/visuals/source";

const mocks = vi.hoisted(() => ({
    ensureDocAccess: vi.fn(),
    filterAccessibleDocumentIds: vi.fn(),
    loadActiveVersion: vi.fn(),
    downloadFile: vi.fn(),
    render: vi.fn(),
    buildVisualDocx: vi.fn(),
    persistGeneratedFile: vi.fn(),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    ensureDocAccess: mocks.ensureDocAccess,
    filterAccessibleDocumentIds: mocks.filterAccessibleDocumentIds,
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
    loadActiveVersion: mocks.loadActiveVersion,
}));
vi.mock("../../../lib/storage", () => ({ downloadFile: mocks.downloadFile }));
vi.mock("../../../lib/sandbox", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/sandbox")>()),
    getSandbox: () => ({ render: mocks.render }),
}));
vi.mock("../../chat/chat.service", () => ({
    buildVisualDocx: mocks.buildVisualDocx,
    persistGeneratedFile: mocks.persistGeneratedFile,
}));

import { createDocxFromVisual, exportVisual, visualDocx, visualSnapshot } from "../visuals.export";

const document = { id: "d1", user_id: "u1", project_id: null, org_id: null, workflow_id: null };
const version = (file_type: string) => ({
    id: "v1", storage_path: "generated/u1/d1/generated.html", pdf_storage_path: null, version_number: 1,
    filename: "Lease map.html", source: "generated", file_type, size_bytes: 1, page_count: null, textless_page_count: null,
});
const stored = serializeVisual({
    title: "Lease map", kind: "document_map", summary: "", html: "<p>x</p>", kit: "1",
    createdAt: "2026-10-20T14:32:00.000Z",
    sources: [{ document_id: "src-1", version_id: "sv1", filename: "Lease.pdf" }],
});
const target = { documentId: "d1", versionId: null, userId: "u1" };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "owner", orgRole: null, isCreator: true });
    mocks.filterAccessibleDocumentIds.mockImplementation(async (ids: string[]) => ids);
    mocks.loadActiveVersion.mockResolvedValue(version("html"));
    mocks.downloadFile.mockResolvedValue(stored);
});

describe("exportVisual", () => {
    it("answers not found for a caller without access and never renders", async () => {
        mocks.ensureDocAccess.mockResolvedValue({ ok: false });
        const { db } = scriptedDb([{ table: "documents", data: document }]);
        await expect(exportVisual(db, target)).resolves.toMatchObject({ ok: false, kind: "not_found" });
        expect(mocks.render).not.toHaveBeenCalled();
    });

    it("refuses a document that is not a visual", async () => {
        mocks.loadActiveVersion.mockResolvedValue(version("docx"));
        const { db } = scriptedDb([{ table: "documents", data: document }]);
        await expect(exportVisual(db, target)).resolves.toMatchObject({ ok: false, code: "not_a_visual" });
    });

    it("maps a missing renderer to render_unavailable and a pdf to a download named after the visual", async () => {
        mocks.render.mockResolvedValueOnce({ ok: false, code: "render_unavailable" });
        const first = scriptedDb([{ table: "documents", data: document }]);
        await expect(exportVisual(first.db, target)).resolves.toMatchObject({ ok: false, kind: "unavailable", code: "render_unavailable" });

        mocks.render.mockResolvedValueOnce({ ok: true, bytes: Buffer.from("pdf") });
        const second = scriptedDb([{ table: "documents", data: document }]);
        const result = await exportVisual(second.db, target);
        expect(result).toMatchObject({ ok: true, data: { bytes: Buffer.from("pdf"), filename: "Lease map.pdf" } });
        expect(mocks.render.mock.calls[1][0]).toMatchObject({ format: "pdf", html: expect.stringContaining("data-mv-export") });
    });
});

describe("createDocxFromVisual", () => {
    it("refuses a project viewer before rendering", async () => {
        mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "viewer", orgRole: null, isCreator: false });
        const { db } = scriptedDb([{ table: "documents", data: { ...document, project_id: "p1" } }]);
        await expect(createDocxFromVisual(db, target)).resolves.toMatchObject({ ok: false, kind: "forbidden" });
        expect(mocks.render).not.toHaveBeenCalled();
        expect(mocks.persistGeneratedFile).not.toHaveBeenCalled();
    });

    it("saves the rendered blocks as a document titled after the visual", async () => {
        const blocks = [
            { type: "heading", level: 1, text: "Lease map" },
            { type: "paragraph", text: "Who owns what." },
        ];
        mocks.render.mockResolvedValue({ ok: true, blocks });
        mocks.buildVisualDocx.mockResolvedValue({ buffer: Buffer.from("docx") });
        mocks.persistGeneratedFile.mockResolvedValue({ document_id: "d2", version_id: "v2", filename: "Lease map.docx" });
        const { db } = scriptedDb([{ table: "documents", data: document }]);
        await expect(createDocxFromVisual(db, target)).resolves.toMatchObject({ ok: true, data: { document_id: "d2" } });
        expect(mocks.buildVisualDocx).toHaveBeenCalledWith(blocks);
        expect(mocks.persistGeneratedFile.mock.calls[0][0]).toMatchObject({
            title: "Lease map", extension: "docx", buffer: Buffer.from("docx"), userId: "u1",
        });
    });
});

describe("visualDocx", () => {
    it("builds the file for insertion and names it after the visual", async () => {
        mocks.render.mockResolvedValue({ ok: true, blocks: [] });
        mocks.buildVisualDocx.mockResolvedValue({ buffer: Buffer.from("docx") });
        const { db } = scriptedDb([{ table: "documents", data: document }]);
        const result = await visualDocx(db, { documentId: "d1", versionId: null, userId: "u1" });
        expect(result).toMatchObject({ ok: true, data: { bytes: Buffer.from("docx"), filename: "Lease map.docx" } });
        expect(mocks.buildVisualDocx).toHaveBeenCalledWith([], { forInsert: true });
    });
});

describe("visualSnapshot", () => {
    it("reports the date and marks a source whose current version moved on", async () => {
        const { db } = scriptedDb([
            { table: "documents", data: document },
            { table: "documents", data: [{ id: "src-1", current_version_id: "sv2" }] },
        ]);
        await expect(visualSnapshot(db, { documentId: "d1", versionId: null, userId: "u1" })).resolves.toEqual({
            ok: true,
            data: { created_at: "2026-10-20T14:32:00.000Z", sources: [{ document_id: "src-1", filename: "Lease.pdf", stale: true }] },
        });
    });

    it("does not report a source the caller cannot read as stale", async () => {
        mocks.filterAccessibleDocumentIds.mockResolvedValue([]);
        const { db } = scriptedDb([{ table: "documents", data: document }]);
        const result = await visualSnapshot(db, { documentId: "d1", versionId: null, userId: "u1" });
        expect(result.ok && result.data.sources[0].stale).toBe(false);
    });
});
