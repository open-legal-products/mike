import { describe, it, expect, vi, beforeEach } from "vitest";
import type { createServerSupabase } from "../../supabase";
import type { AuditEventInput } from "../../audit";

// Every stub below carries the argument list of the function it replaces.
// That is what makes `mock.calls[n][m]` a real argument rather than an
// element of an untyped rest array — the assertions read those positions.
type Db = ReturnType<typeof createServerSupabase>;

const insertAuditEvent =
    vi.fn<(db: Db, event: AuditEventInput) => Promise<void>>(async () => {});
const recordAudit =
    vi.fn<(db: Db, event: AuditEventInput) => Promise<void>>(async () => {});
vi.mock("../../audit", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../audit")>();
    return {
        ...actual,
        insertAuditEvent: (db: Db, event: AuditEventInput) =>
            insertAuditEvent(db, event),
        recordAudit: (db: Db, event: AuditEventInput) =>
            recordAudit(db, event),
    };
});

const deleteUserAccountData =
    vi.fn<
        (db: Db, userId: string, userEmail?: string | null) => Promise<void>
    >(async () => {});
vi.mock("../../userDataCleanup", () => ({
    deleteUserAccountData: (
        db: Db,
        userId: string,
        userEmail?: string | null,
    ) => deleteUserAccountData(db, userId, userEmail),
}));

const buildUserAccountExport =
    vi.fn<
        (
            db: Db,
            userId: string,
            userEmail?: string | null,
        ) => Promise<{ hello: string }>
    >(async () => ({ hello: "world" }));
vi.mock("../../userDataExport", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../userDataExport")>();
    return {
        ...actual,
        buildUserAccountExport: (
            db: Db,
            userId: string,
            userEmail?: string | null,
        ) => buildUserAccountExport(db, userId, userEmail),
    };
});

const buildAuditCsv = vi.fn(
    async (..._a: unknown[]) => "created_at,user\n2026-01-01,a@b.test",
);
vi.mock("../../auditExport", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../auditExport")>();
    return {
        ...actual,
        buildAuditCsv: (...a: unknown[]) => buildAuditCsv(...a),
    };
});

const ACTIVE_VERSION = {
    id: "v1",
    storage_path: "docs/d1/v1.docx",
    pdf_storage_path: null,
    version_number: 2,
    filename: "brief.docx",
    source: "assistant_edit",
    file_type: "docx",
    size_bytes: 3,
    page_count: null,
};

const ensureDocAccess = vi.fn(async (..._a: unknown[]) => ({ ok: true }));
vi.mock("../../access", () => ({
    ensureDocAccess: (...a: unknown[]) => ensureDocAccess(...a),
}));

const loadActiveVersion = vi.fn(
    async (..._a: unknown[]) => ACTIVE_VERSION as typeof ACTIVE_VERSION | null,
);
vi.mock("../../documentVersions", async (importOriginal) => {
    const actual =
        await importOriginal<typeof import("../../documentVersions")>();
    return {
        ...actual,
        loadActiveVersion: (...a: unknown[]) => loadActiveVersion(...a),
    };
});

const uploadFile =
    vi.fn<
        (key: string, content: ArrayBuffer, contentType: string) => Promise<void>
    >(async () => {});
const deleteFile = vi.fn<(key: string) => Promise<void>>(async () => {});
const listFiles = vi.fn<(prefix: string) => Promise<string[]>>(
    async () => [] as string[],
);
const downloadFile = vi.fn(async (..._a: unknown[]) => new Uint8Array([1, 2, 3]));
vi.mock("../../storage", () => ({
    uploadFile: (key: string, content: ArrayBuffer, contentType: string) =>
        uploadFile(key, content, contentType),
    deleteFile: (key: string) => deleteFile(key),
    listFiles: (prefix: string) => listFiles(prefix),
    downloadFile: (...a: unknown[]) => downloadFile(...a),
}));

import {
    handleChatTurnAudit,
    handleAccountDelete,
    handleStorageCleanup,
    handleExportBuild,
    MAX_ZIP_EXPORT_DOCUMENTS,
} from "../handlers";
import type { DbJob } from "../types";

const JOB = (kind: string, payload: Record<string, unknown>): DbJob => ({
    id: "job-1",
    kind,
    payload,
    status: "running",
    attempts: 1,
    max_attempts: 3,
    run_at: "",
    claimed_at: null,
    finished_at: null,
    last_error: null,
    dedupe_key: null,
    result: null,
    created_at: "",
});

// Minimal db double for the handlers' own db_jobs queries.
function makeDb(selectData: unknown[] = []) {
    const deletes: Record<string, unknown>[] = [];
    function from() {
        const state: { op: string; filters: Record<string, unknown> } = {
            op: "select",
            filters: {},
        };
        const b: Record<string, unknown> = {
            select() {
                return b;
            },
            delete() {
                state.op = "delete";
                return b;
            },
            eq(c: string, v: unknown) {
                state.filters[c] = v;
                return b;
            },
            neq(c: string, v: unknown) {
                state.filters[`neq:${c}`] = v;
                return b;
            },
            in(c: string, v: unknown) {
                state.filters[`in:${c}`] = v;
                return b;
            },
            filter(c: string, _op: string, v: unknown) {
                state.filters[c] = v;
                return b;
            },
            then(onF: (v: unknown) => unknown) {
                if (state.op === "delete") deletes.push({ ...state.filters });
                return Promise.resolve({
                    data: state.op === "select" ? selectData : null,
                    error: null,
                }).then(onF);
            },
        };
        return b;
    }
    return { deletes, from };
}

beforeEach(() => {
    insertAuditEvent.mockReset().mockResolvedValue(undefined);
    recordAudit.mockReset().mockResolvedValue(undefined);
    deleteUserAccountData.mockReset().mockResolvedValue(undefined);
    buildUserAccountExport.mockReset().mockResolvedValue({ hello: "world" });
    uploadFile.mockReset().mockResolvedValue(undefined);
    deleteFile.mockReset().mockResolvedValue(undefined);
    listFiles.mockReset().mockResolvedValue([]);
    downloadFile.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
    buildAuditCsv
        .mockReset()
        .mockResolvedValue("created_at,user\n2026-01-01,a@b.test");
    ensureDocAccess.mockReset().mockResolvedValue({ ok: true });
    loadActiveVersion.mockReset().mockResolvedValue(ACTIVE_VERSION);
});

describe("handleChatTurnAudit", () => {
    it("fans out the turn's mapped rows via THROWING inserts (retry signal)", async () => {
        const db = makeDb();
        await handleChatTurnAudit(
            db as never,
            JOB("audit.chat_turn", {
                base: { userId: "u1", chatId: "c1" },
                events: [
                    { type: "doc_created", filename: "a.docx", document_id: "d1" },
                ],
            }),
        );
        // chat.message + document.generated
        expect(insertAuditEvent).toHaveBeenCalledTimes(2);
        const actions = insertAuditEvent.mock.calls.map((c) => c[1].action);
        expect(actions).toEqual(["chat.message", "document.generated"]);
    });

    it("propagates insert failures so the job retries", async () => {
        insertAuditEvent.mockRejectedValueOnce(new Error("db hiccup"));
        await expect(
            handleChatTurnAudit(
                makeDb() as never,
                JOB("audit.chat_turn", {
                    base: { userId: "u1", chatId: null },
                    events: [],
                }),
            ),
        ).rejects.toThrow(/db hiccup/);
    });

    it("ignores a malformed payload instead of retrying it forever", async () => {
        await handleChatTurnAudit(
            makeDb() as never,
            JOB("audit.chat_turn", {}),
        );
        expect(insertAuditEvent).not.toHaveBeenCalled();
    });
});

describe("handleAccountDelete", () => {
    it("runs the cascade and purges the user's other queue rows (not itself)", async () => {
        const db = makeDb([]);
        await handleAccountDelete(
            db as never,
            JOB("account.delete", { userId: "u1", userEmail: "u@x.test" }),
        );
        expect(deleteUserAccountData).toHaveBeenCalledWith(db, "u1", "u@x.test");
        // Two purge deletes (payload->>userId and payload->base->>userId),
        // both excluding the running job's own row.
        expect(db.deletes).toHaveLength(2);
        for (const d of db.deletes) expect(d["neq:id"]).toBe("job-1");
    });

    it("removes export artifacts the user still had parked in storage", async () => {
        const db = makeDb([
            { id: "e1", result: { storage_path: "exports/u1/e1.json" } },
        ]);
        await handleAccountDelete(
            db as never,
            JOB("account.delete", { userId: "u1" }),
        );
        expect(deleteFile).toHaveBeenCalledWith("exports/u1/e1.json");
    });
});

describe("handleStorageCleanup", () => {
    it("deletes explicit keys plus everything under the given prefixes", async () => {
        listFiles.mockResolvedValueOnce(["p/1.pdf", "p/2.pdf"]);
        await handleStorageCleanup(
            makeDb() as never,
            JOB("storage.cleanup", { keys: ["a.pdf"], prefixes: ["p/"] }),
        );
        const deleted = deleteFile.mock.calls.map((c) => c[0]);
        expect(deleted.sort()).toEqual(["a.pdf", "p/1.pdf", "p/2.pdf"]);
    });

    it("deletes what it can and throws so the retry re-runs the remainder", async () => {
        deleteFile
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("storage down"));
        await expect(
            handleStorageCleanup(
                makeDb() as never,
                JOB("storage.cleanup", { keys: ["a.pdf", "b.pdf"] }),
            ),
        ).rejects.toThrow(/1\/2 deletes failed/);
    });
});

describe("handleExportBuild", () => {
    it("builds, uploads under the user's exports/ prefix, and returns the signed link", async () => {
        const out = await handleExportBuild(
            makeDb() as never,
            JOB("export.build", { userId: "u1", type: "account" }),
        );
        expect(buildUserAccountExport).toHaveBeenCalled();
        const [path, , contentType] = uploadFile.mock.calls[0];
        expect(path).toMatch(/^exports\/u1\/job-1-/);
        expect(contentType).toBe("application/json");
        expect(out.storage_path).toBe(path);
        expect(out.filename).toMatch(/\.json$/);
        // Completion writes the same audit action the old sync route wrote.
        expect(recordAudit).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ action: "export.account" }),
        );
    });

    it("rejects malformed payloads (bad type) instead of building garbage", async () => {
        await expect(
            handleExportBuild(
                makeDb() as never,
                JOB("export.build", { userId: "u1", type: "everything" }),
            ),
        ).rejects.toThrow(/malformed payload/);
    });

    it("builds the history CSV from the job's stored filters", async () => {
        const query = { sortBy: "created_at", sortDirection: "desc", page: 3, limit: 2000 };
        const out = await handleExportBuild(
            makeDb() as never,
            JOB("export.build", {
                userId: "u1",
                userEmail: "u@x.test",
                type: "audit-csv",
                query,
            }),
        );
        expect(buildAuditCsv).toHaveBeenCalledWith(
            expect.anything(),
            "u1",
            "u@x.test",
            query,
        );
        const [path, , contentType] = uploadFile.mock.calls[0];
        expect(path).toBe("exports/u1/job-1-history-export.csv");
        expect(contentType).toMatch(/^text\/csv/);
        expect(out.filename).toBe("history-export.csv");
        expect(out.content_type).toMatch(/^text\/csv/);
        // The sync /audit/export route records no audit row; nor does this.
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("rejects an audit-csv job with no validated query", async () => {
        await expect(
            handleExportBuild(
                makeDb() as never,
                JOB("export.build", { userId: "u1", type: "audit-csv" }),
            ),
        ).rejects.toThrow(/malformed payload/);
    });

    it("re-verifies access at build time and skips docs the user lost", async () => {
        const db = makeDb([
            { id: "d1", user_id: "u1", project_id: null },
            { id: "d2", user_id: "someone-else", project_id: "p1" },
        ]);
        ensureDocAccess.mockImplementation(
            async (doc: unknown) =>
                ({ ok: (doc as { id: string }).id === "d1" }) as { ok: boolean },
        );

        const out = await handleExportBuild(
            db as never,
            JOB("export.build", {
                userId: "u1",
                userEmail: "u@x.test",
                type: "documents-zip",
                document_ids: ["d1", "d2"],
            }),
        );

        expect(ensureDocAccess).toHaveBeenCalledTimes(2);
        expect(loadActiveVersion.mock.calls.map((c) => c[0])).toEqual(["d1"]);
        const [path, , contentType] = uploadFile.mock.calls[0];
        expect(path).toBe("exports/u1/job-1-documents.zip");
        expect(contentType).toBe("application/zip");
        expect(out.filename).toBe("documents.zip");
        expect(out.content_type).toBe("application/zip");
    });

    it("fails a documents-zip job whose documents are all inaccessible", async () => {
        ensureDocAccess.mockResolvedValue({ ok: false });
        await expect(
            handleExportBuild(
                makeDb([{ id: "d1", user_id: "u2", project_id: null }]) as never,
                JOB("export.build", {
                    userId: "u1",
                    type: "documents-zip",
                    document_ids: ["d1"],
                }),
            ),
        ).rejects.toThrow(/no accessible documents/);
    });

    it("rejects empty and oversized documents-zip selections", async () => {
        for (const document_ids of [
            [],
            Array.from({ length: MAX_ZIP_EXPORT_DOCUMENTS + 1 }, (_, i) => `d${i}`),
            ["d1", 42],
        ]) {
            await expect(
                handleExportBuild(
                    makeDb() as never,
                    JOB("export.build", {
                        userId: "u1",
                        type: "documents-zip",
                        document_ids,
                    }),
                ),
            ).rejects.toThrow(/malformed payload/);
        }
        expect(uploadFile).not.toHaveBeenCalled();
    });
});
