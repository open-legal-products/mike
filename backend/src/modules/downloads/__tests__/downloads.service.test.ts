import { describe, expect, it, vi } from "vitest";
import { scriptedDb } from "../../../__tests__/helpers/scriptedDb";
import { serializeVisual } from "../../../lib/visuals/source";

const mocks = vi.hoisted(() => ({
    ensureDocAccess: vi.fn(),
    downloadFile: vi.fn(),
    verifyDownload: vi.fn(),
}));

vi.mock("../../../lib/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/access")>()),
    ensureDocAccess: mocks.ensureDocAccess,
}));
vi.mock("../../../lib/storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/storage")>()),
    downloadFile: mocks.downloadFile,
}));
vi.mock("../../../lib/downloadTokens", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/downloadTokens")>()),
    verifyDownload: mocks.verifyDownload,
}));

import { resolveTokenDownload } from "../downloads.service";

describe("resolveTokenDownload", () => {
    it("serves a visual as the composed page", async () => {
        mocks.verifyDownload.mockReturnValue({ path: "generated/u1/d1/generated.html", filename: "Lease map.html" });
        mocks.ensureDocAccess.mockResolvedValue({ ok: true, projectRole: "owner", orgRole: null, isCreator: true });
        mocks.downloadFile.mockResolvedValue(serializeVisual({
            title: "Lease map", kind: "document_map", summary: "", html: "<p>x</p>", kit: "1", createdAt: "", sources: [],
        }));
        const { db } = scriptedDb([
            { table: "document_versions", data: { id: "v1", document_id: "d1", file_type: "html" } },
            { table: "documents", data: { id: "d1", user_id: "u1", project_id: null, org_id: null, workflow_id: null } },
        ]);
        const result = await resolveTokenDownload(db, { token: "t", userId: "u1", userEmail: undefined });
        expect(result).toMatchObject({ ok: true, isVisual: true, contentType: "text/html; charset=utf-8" });
        expect(result.ok && result.bytes.toString("utf8")).toContain('<meta http-equiv="Content-Security-Policy"');
    });
});
