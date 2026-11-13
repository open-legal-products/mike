import { beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import type { ExportBuildRequest } from "../exportContracts";

const { filenames, deniedIds, download, upload } = vi.hoisted(() => ({
    filenames: new Map<string, { filename: string | null; version_number?: number; source?: string }>(),
    deniedIds: new Set<string>(),
    download: vi.fn<(key: string) => Promise<ArrayBuffer>>(),
    upload: vi.fn<(key: string, bytes: ArrayBuffer, contentType: string) => Promise<void>>(),
}));

// Keep the queued ZIP builder real; replace its I/O and unrelated export paths.
vi.mock("../../../lib/storage", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/storage")>()),
    downloadFile: download,
    uploadFile: upload,
}));
vi.mock("../../../lib/access", () => ({
    createDocumentAccessChecker: () => async (doc: { id: string }) => ({ ok: !deniedIds.has(doc.id) }),
}));
vi.mock("../../../lib/documentVersions", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../../lib/documentVersions")>()),
    attachActiveVersionPaths: async (_db: unknown, docs: Array<Record<string, unknown>>) => {
        for (const doc of docs) {
            const id = doc.id as string;
            const version = filenames.get(id);
            Object.assign(doc, {
                storage_path: `${id}.docx`,
                filename: version ? version.filename : `${id}.docx`,
                active_version_number: version?.version_number ?? 1,
                source: version?.source ?? "upload",
            });
        }
        return docs;
    },
}));
vi.mock("../../../lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("../../../lib/auditExport", () => ({ AUDIT_CSV_FILENAME: "audit.csv", buildAuditCsv: vi.fn() }));
vi.mock("../buildJsonExport", () => ({
    buildUserAccountExport: vi.fn(), buildUserChatsExport: vi.fn(),
    buildUserTabularReviewsExport: vi.fn(), userExportFilename: vi.fn(),
}));
vi.mock("../../../lib/memory/archive", () => ({ buildMemoryArchive: vi.fn() }));
vi.mock("../../../lib/dbq/runner", () => ({ NonRetryableJobError: class extends Error {} }));
vi.mock("../../../modules/orgs/orgs.service", () => ({ memberDataActionAllowed: vi.fn() }));

import { buildExport } from "../buildExport";

const job: ExportBuildRequest = {
    id: "export-1",
    payload: { userId: "u1", type: "documents-zip", document_ids: ["d1", "d2"] },
};
const db = {
    from: () => ({ select: () => ({ in: async (_column: string, ids: string[]) => ({
        data: ids.map(id => ({ id, user_id: "u1", project_id: null })), error: null,
    }) }) }),
};

beforeEach(() => {
    filenames.clear();
    deniedIds.clear();
    download.mockReset().mockImplementation(async key => Uint8Array.from(Buffer.from(`original bytes for ${key}`)).buffer);
    upload.mockReset().mockResolvedValue(undefined);
});

async function expectArchive(names: string[], ids: string[], attempt = 0) {
    const zip = await JSZip.loadAsync(upload.mock.calls[attempt]![1]);
    expect(Object.keys(zip.files)).toEqual(names);
    for (const [index, name] of names.entries()) {
        expect(await zip.file(name)!.async("string")).toBe(`original bytes for ${ids[index]}.docx`);
    }
}

describe("queued document ZIP filenames", () => {
    it("preserves all eleven documents and exact bytes when two share a filename", async () => {
        const ids = Array.from({ length: 11 }, (_, index) => `document-${index}`);
        filenames.set(ids[0]!, { filename: "Agreement.pdf" });
        filenames.set(ids[1]!, { filename: "Agreement.pdf" });

        await buildExport(db as never, { ...job, payload: { ...job.payload, document_ids: ids } });

        await expectArchive(["Agreement.pdf", "Agreement (2).pdf", ...ids.slice(2).map(id => `${id}.docx`)], ids);
    });

    it("avoids existing suffixes and collisions from edited versions or missing filenames on every retry", async () => {
        const entries = [
            { filename: "Agreement (2).pdf" },
            { filename: "Agreement.pdf" },
            { filename: "Agreement.pdf" },
            { filename: "Agreement.pdf", version_number: 3, source: "assistant_edit" },
            { filename: "Agreement.pdf", version_number: 3, source: "assistant_edit" },
            { filename: null },
            { filename: null },
        ];
        const ids = entries.map((entry, index) => {
            const id = `document-${index}`;
            filenames.set(id, entry);
            return id;
        });
        const selectedJob = { ...job, payload: { ...job.payload, document_ids: ids } };
        for (let attempt = 0; attempt < 2; attempt++) {
            await buildExport(db as never, selectedJob);
            await expectArchive([
                "Agreement (2).pdf", "Agreement.pdf", "Agreement (3).pdf",
                "Agreement [Edited V3].pdf", "Agreement [Edited V3] (2).pdf",
                "Untitled document", "Untitled document (2)",
            ], ids, attempt);
        }
        expect(upload.mock.calls[0]![0]).toBe(upload.mock.calls[1]![0]);
    });

    it("keeps unique source filenames and their bytes unchanged", async () => {
        await buildExport(db as never, job);
        await expectArchive(["d1.docx", "d2.docx"], ["d1", "d2"]);
    });

    it("does not read or reserve a name for a document that is no longer accessible", async () => {
        filenames.set("d1", { filename: "Agreement.pdf" });
        filenames.set("d2", { filename: "Agreement.pdf" });
        deniedIds.add("d1");

        await buildExport(db as never, job);

        expect(download).toHaveBeenCalledExactlyOnceWith("d2.docx");
        await expectArchive(["Agreement.pdf"], ["d2"]);
    });

    it("does not publish a partial archive when an accessible source read fails", async () => {
        download.mockRejectedValueOnce(new Error("synthetic storage failure"));

        await expect(buildExport(db as never, job)).rejects.toThrow("synthetic storage failure");
        expect(upload).not.toHaveBeenCalled();
    });
});
