import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage", () => ({
    deleteFile: vi.fn(async () => {}),
    listFiles: vi.fn(async () => [] as string[]),
    // Kept real: cleanup must delete the exact key the
    // document.precompute_text job writes, so a fake would defeat the point
    // of asserting on the collected paths.
    extractedTextKey: (versionId: string) => `extracted-text/${versionId}.txt`,
}));

import { deleteFile, listFiles } from "../storage";
import {
    deleteAllUserChats,
    deleteAllUserTabularReviews,
    deleteUserProjects,
    deleteUserAccountData,
} from "../userDataCleanup";

const deleteFileMock = vi.mocked(deleteFile);
const listFilesMock = vi.mocked(listFiles);

type Row = Record<string, unknown>;

/**
 * Stateful Supabase mock: deletes and updates mutate `tables`, so tests can
 * assert on exactly which rows survived a cleanup call. Supports the chains
 * userDataCleanup uses (select/delete/update + eq/in/not/order/filter-cs) and can
 * inject a delete error per table to exercise error propagation.
 */
function makeDb(
    initialTables: Record<string, Row[]>,
    options: { deleteErrors?: Record<string, string> } = {},
) {
    const tables: Record<string, Row[]> = {};
    for (const [name, rows] of Object.entries(initialTables)) {
        tables[name] = rows.map((row) => ({ ...row }));
    }

    const removeRows = (
        table: string,
        predicate: (row: Row) => boolean,
    ): Row[] => {
        const rows = tables[table] ?? [];
        const removed = rows.filter(predicate);
        tables[table] = rows.filter((row) => !predicate(row));
        return removed;
    };

    // The production schema uses FK cascades for project/review/chat trees.
    // Model those cascades here so a parent-only DELETE exercises the same
    // behavior without reintroducing unsafe pre-delete child enumeration.
    const cascadeDelete = (table: string, removed: Row[]) => {
        const removedIds = removed
            .map((row) => row.id)
            .filter((id): id is string => typeof id === "string");
        if (removedIds.length === 0) return;

        if (table === "projects") {
            cascadeDelete(
                "documents",
                removeRows("documents", (row) =>
                    removedIds.includes(String(row.project_id)),
                ),
            );
            cascadeDelete(
                "chats",
                removeRows("chats", (row) =>
                    removedIds.includes(String(row.project_id)),
                ),
            );
            cascadeDelete(
                "tabular_reviews",
                removeRows("tabular_reviews", (row) =>
                    removedIds.includes(String(row.project_id)),
                ),
            );
            removeRows("project_subfolders", (row) =>
                removedIds.includes(String(row.project_id)),
            );
            cascadeDelete(
                "memory_files",
                removeRows("memory_files", (row) =>
                    removedIds.includes(String(row.project_id)),
                ),
            );
        } else if (table === "documents") {
            removeRows("document_versions", (row) =>
                removedIds.includes(String(row.document_id)),
            );
        } else if (table === "chats") {
            removeRows("chat_messages", (row) =>
                removedIds.includes(String(row.chat_id)),
            );
        } else if (table === "tabular_reviews") {
            cascadeDelete(
                "tabular_review_chats",
                removeRows("tabular_review_chats", (row) =>
                    removedIds.includes(String(row.review_id)),
                ),
            );
            removeRows("tabular_cells", (row) =>
                removedIds.includes(String(row.review_id)),
            );
            removeRows("tabular_review_rows", (row) =>
                removedIds.includes(String(row.review_id)),
            );
        } else if (table === "tabular_review_chats") {
            removeRows("tabular_review_chat_messages", (row) =>
                removedIds.includes(String(row.chat_id)),
            );
        } else if (table === "word_documents") {
            cascadeDelete(
                "word_chats",
                removeRows("word_chats", (row) =>
                    removedIds.includes(String(row.document_id)),
                ),
            );
        } else if (table === "word_chats") {
            removeRows("word_chat_messages", (row) =>
                removedIds.includes(String(row.chat_id)),
            );
        } else if (table === "memory_files") {
            const versions = removeRows("memory_file_versions", (row) =>
                removedIds.includes(String(row.memory_file_id)),
            );
            const paths = versions
                .map((row) => row.storage_path)
                .filter((path): path is string => typeof path === "string");
            if (paths.length > 0) {
                const jobs = tables.db_jobs ?? (tables.db_jobs = []);
                jobs.push({
                    id: `cleanup-cascade-${removedIds.join("-")}`,
                    kind: "storage.cleanup",
                    payload: { keys: paths, prefixes: [] },
                });
            }
            removeRows("memory_object_candidates", (row) =>
                removedIds.includes(String(row.memory_file_id)),
            );
        }
    };
    const db = {
        async rpc(name: string, args: Record<string, unknown>) {
            if (name !== "wipe_memory_file") {
                return { data: null, error: { message: `unknown rpc: ${name}` } };
            }
            const file = (tables.memory_files ?? []).find(
                (row) => row.id === args.p_memory_file_id,
            );
            if (!file) {
                return { data: null, error: { message: "memory_file_not_found" } };
            }
            const versions = (tables.memory_file_versions ?? []).filter(
                (row) => row.memory_file_id === file.id,
            );
            const paths = versions
                .map((row) => row.storage_path)
                .filter((path): path is string => typeof path === "string");
            if (paths.length > 0) {
                const jobs = tables.db_jobs ?? (tables.db_jobs = []);
                jobs.push({
                    id: `cleanup-${String(file.id)}`,
                    kind: "storage.cleanup",
                    payload: { keys: paths, prefixes: [] },
                });
            }
            tables.memory_file_versions = (
                tables.memory_file_versions ?? []
            ).filter((row) => row.memory_file_id !== file.id);
            Object.assign(file, {
                enabled: args.p_enabled,
                version: 0,
                current_version_id: null,
            });
            return {
                data: [{ storage_paths: paths, new_epoch: 1 }],
                error: null,
            };
        },
        from(table: string) {
            const rowsOf = () => tables[table] ?? (tables[table] = []);
            let predicate: (row: Row) => boolean = () => true;
            let mode: "select" | "delete" | "update" = "select";
            let patch: Row = {};
            const narrow = (next: (row: Row) => boolean) => {
                const prev = predicate;
                predicate = (row) => prev(row) && next(row);
            };
            const query: any = {
                select: () => query,
                delete: () => {
                    mode = "delete";
                    return query;
                },
                update: (value: Row) => {
                    mode = "update";
                    patch = value;
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    narrow((row) => row[column] === value);
                    return query;
                },
                order: () => query,
                in: (column: string, values: unknown[]) => {
                    narrow((row) => values.includes(row[column]));
                    return query;
                },
                // Retention asks "is this row org-owned?" as
                // .not("org_id", "is", null); a missing key and an explicit
                // null both mean "no", which is what the column means too.
                not: (column: string, operator: string, value: unknown) => {
                    if (operator === "is" && value === null) {
                        narrow((row) => row[column] !== null && row[column] !== undefined);
                    }
                    return query;
                },
                filter: (column: string, operator: string, value: string) => {
                    if (operator !== "cs") return query;
                    const expected = (JSON.parse(value) as string[]).map((item) =>
                        item.toLowerCase(),
                    );
                    narrow((row) => {
                        const actual = row[column];
                        if (!Array.isArray(actual)) return false;
                        const normalized = actual.map((item) =>
                            String(item).toLowerCase(),
                        );
                        return expected.every((item) => normalized.includes(item));
                    });
                    return query;
                },
                then: (
                    resolve: (value: { data: Row[] | null; error: unknown }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) => {
                    let result: { data: Row[] | null; error: unknown };
                    if (mode === "delete") {
                        const message = options.deleteErrors?.[table];
                        if (message) {
                            result = { data: null, error: { message } };
                        } else {
                            const removed = rowsOf().filter(predicate);
                            tables[table] = rowsOf().filter(
                                (row) => !predicate(row),
                            );
                            cascadeDelete(table, removed);
                            // Supabase returns the deleted rows when the call
                            // chains .select(); the grant cleanup uses that to
                            // learn which projects need their mirror rebuilt.
                            result = { data: removed, error: null };
                        }
                    } else if (mode === "update") {
                        for (const row of rowsOf().filter(predicate)) {
                            Object.assign(row, patch);
                        }
                        result = { data: null, error: null };
                    } else {
                        result = {
                            data: rowsOf().filter(predicate).map((row) => ({ ...row })),
                            error: null,
                        };
                    }
                    return Promise.resolve(result).then(resolve, reject);
                },
            };
            return query;
        },
    };
    return { db: db as any, tables };
}

const ids = (rows: Row[] | undefined) => (rows ?? []).map((row) => row.id);

beforeEach(() => {
    deleteFileMock.mockClear();
    deleteFileMock.mockResolvedValue(undefined as never);
    listFilesMock.mockClear();
    listFilesMock.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// deleteAllUserChats
// ---------------------------------------------------------------------------

describe("deleteAllUserChats", () => {
    it("deletes only the target user's assistant, Word, and tabular chats", async () => {
        const { db, tables } = makeDb({
            chats: [
                { id: "c1", user_id: "u1" },
                { id: "c2", user_id: "u2" },
            ],
            tabular_review_chats: [
                { id: "tc1", user_id: "u1" },
                { id: "tc2", user_id: "u2" },
            ],
            word_documents: [
                { id: "wd1", user_id: "u1" },
                { id: "wd2", user_id: "u2" },
            ],
        });
        await deleteAllUserChats(db, "u1");
        expect(ids(tables.chats)).toEqual(["c2"]);
        expect(ids(tables.tabular_review_chats)).toEqual(["tc2"]);
        expect(ids(tables.word_documents)).toEqual(["wd2"]);
    });

    it("surfaces delete failures with context", async () => {
        const { db } = makeDb(
            { chats: [{ id: "c1", user_id: "u1" }], tabular_review_chats: [] },
            { deleteErrors: { chats: "boom" } },
        );
        await expect(deleteAllUserChats(db, "u1")).rejects.toThrow(
            "Failed to delete assistant chats: boom",
        );
    });
});

// ---------------------------------------------------------------------------
// deleteAllUserTabularReviews
// ---------------------------------------------------------------------------

describe("deleteAllUserTabularReviews", () => {
    const fixture = () =>
        makeDb({
            tabular_reviews: [
                { id: "r1", user_id: "u1" },
                { id: "r2", user_id: "u1" },
                { id: "r-other", user_id: "u2" },
            ],
            tabular_review_chats: [
                { id: "rc1", review_id: "r1" },
                { id: "rc-other", review_id: "r-other" },
            ],
            tabular_review_chat_messages: [
                { id: "rm1", chat_id: "rc1" },
                { id: "rm-other", chat_id: "rc-other" },
            ],
            tabular_cells: [
                { id: "cell1", review_id: "r1" },
                { id: "cell-other", review_id: "r-other" },
            ],
        });

    it("atomically cascades messages, chats, and cells with the reviews", async () => {
        const { db, tables } = fixture();
        await expect(deleteAllUserTabularReviews(db, "u1")).resolves.toBe(2);
        expect(ids(tables.tabular_reviews)).toEqual(["r-other"]);
        expect(ids(tables.tabular_review_chats)).toEqual(["rc-other"]);
        expect(ids(tables.tabular_review_chat_messages)).toEqual(["rm-other"]);
        expect(ids(tables.tabular_cells)).toEqual(["cell-other"]);
    });

    it("returns 0 and deletes nothing for a user with no reviews", async () => {
        const { db, tables } = fixture();
        await expect(deleteAllUserTabularReviews(db, "u3")).resolves.toBe(0);
        expect(tables.tabular_reviews).toHaveLength(3);
        expect(tables.tabular_cells).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// deleteUserProjects
// ---------------------------------------------------------------------------

describe("deleteUserProjects", () => {
    const fixture = (options: { deleteErrors?: Record<string, string> } = {}) =>
        makeDb({
            projects: [
                { id: "p1", user_id: "u1" },
                { id: "p2", user_id: "u1" },
                { id: "p-other", user_id: "u2" },
            ],
            documents: [
                { id: "d1", user_id: "u1", project_id: "p1" },
                { id: "d-loose", user_id: "u1", project_id: null },
                { id: "d-other", user_id: "u2", project_id: "p-other" },
            ],
            document_versions: [
                {
                    id: "v1",
                    document_id: "d1",
                    storage_path: "documents/u1/d1/source.pdf",
                    pdf_storage_path: "documents/u1/d1/converted.pdf",
                },
                {
                    id: "v-other",
                    document_id: "d-other",
                    storage_path: "documents/u2/d-other/source.pdf",
                    pdf_storage_path: null,
                },
            ],
            chats: [
                { id: "c1", project_id: "p1" },
                { id: "c-other", project_id: "p-other" },
            ],
            chat_messages: [
                { id: "m1", chat_id: "c1" },
                { id: "m-other", chat_id: "c-other" },
            ],
            tabular_reviews: [
                { id: "r1", project_id: "p1" },
                { id: "r-other", project_id: "p-other" },
            ],
            tabular_review_chats: [
                { id: "rc1", review_id: "r1" },
                { id: "rc-other", review_id: "r-other" },
            ],
            tabular_review_chat_messages: [
                { id: "rm1", chat_id: "rc1" },
                { id: "rm-other", chat_id: "rc-other" },
            ],
            tabular_cells: [
                { id: "cell1", review_id: "r1" },
                { id: "cell-other", review_id: "r-other" },
            ],
            project_subfolders: [
                { id: "f1", project_id: "p1" },
                { id: "f-other", project_id: "p-other" },
            ],
            memory_files: [
                {
                    id: "memory-p1",
                    scope: "project",
                    project_id: "p1",
                    enabled: true,
                },
                {
                    id: "memory-p2",
                    scope: "project",
                    project_id: "p2",
                    enabled: true,
                },
                {
                    id: "memory-other",
                    scope: "project",
                    project_id: "p-other",
                    enabled: true,
                },
            ],
            memory_file_versions: [
                {
                    id: "memory-version-p1",
                    memory_file_id: "memory-p1",
                    storage_path:
                        "memories/projects/p1/versions/v1/memory.md",
                },
                {
                    id: "memory-version-other",
                    memory_file_id: "memory-other",
                    storage_path:
                        "memories/projects/p-other/versions/v1/memory.md",
                },
            ],
        }, options);

    it("cascades project contents and storage files for owned projects", async () => {
        const { db, tables } = fixture();
        await expect(deleteUserProjects(db, "u1")).resolves.toBe(2);

        expect(ids(tables.projects)).toEqual(["p-other"]);
        expect(ids(tables.documents)).toEqual(["d-loose", "d-other"]);
        expect(ids(tables.chats)).toEqual(["c-other"]);
        expect(ids(tables.chat_messages)).toEqual(["m-other"]);
        expect(ids(tables.tabular_reviews)).toEqual(["r-other"]);
        expect(ids(tables.tabular_review_chats)).toEqual(["rc-other"]);
        expect(ids(tables.tabular_review_chat_messages)).toEqual(["rm-other"]);
        expect(ids(tables.tabular_cells)).toEqual(["cell-other"]);
        expect(ids(tables.project_subfolders)).toEqual(["f-other"]);
        expect(ids(tables.memory_file_versions)).toEqual([
            "memory-version-other",
        ]);
        expect(tables.db_jobs).toContainEqual(
            expect.objectContaining({
                kind: "storage.cleanup",
                payload: {
                    keys: ["memories/projects/p1/versions/v1/memory.md"],
                    prefixes: [],
                },
            }),
        );

        const deletedPaths = deleteFileMock.mock.calls.map(([path]) => path);
        expect(deletedPaths.sort()).toEqual([
            "documents/u1/d1/converted.pdf",
            "documents/u1/d1/source.pdf",
            // The read_document text cache lives outside the per-user
            // prefixes, so this walk is the only thing that can reach it.
            "extracted-text/v1.txt",
        ]);
    });

    it("restricts deletion to the requested owned projects", async () => {
        const { db, tables } = fixture();
        // p-other belongs to u2, so requesting it must not delete anything of theirs.
        await expect(
            deleteUserProjects(db, "u1", ["p2", "p-other", "p2"]),
        ).resolves.toBe(1);
        expect(ids(tables.projects)).toEqual(["p1", "p-other"]);
        expect(ids(tables.documents)).toEqual(["d1", "d-loose", "d-other"]);
    });

    it("returns 0 for an explicitly empty project list", async () => {
        const { db, tables } = fixture();
        await expect(deleteUserProjects(db, "u1", [])).resolves.toBe(0);
        expect(tables.projects).toHaveLength(3);
    });

    it("returns 0 when the user owns no projects", async () => {
        const { db, tables } = fixture();
        await expect(deleteUserProjects(db, "u3")).resolves.toBe(0);
        expect(tables.projects).toHaveLength(3);
        expect(deleteFileMock).not.toHaveBeenCalled();
    });

    it("leaves storage untouched when a row deletion fails mid-cascade", async () => {
        // Same ordering contract as account deletion: bytes go last, so a
        // failed cascade leaves rows AND bytes for the retry instead of
        // surviving documents whose versions all 404.
        const { db } = fixture({
            deleteErrors: { projects: "connection reset" },
        });

        await expect(deleteUserProjects(db, "u1")).rejects.toThrow();
        expect(deleteFileMock).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// deleteUserAccountData
// ---------------------------------------------------------------------------

describe("deleteUserAccountData", () => {
    const fixture = (options: { deleteErrors?: Record<string, string> } = {}) =>
        makeDb({
            projects: [
                { id: "p1", user_id: "u1", org_id: null },
                {
                    id: "p-other",
                    user_id: "u2",
                    org_id: null,
                },
            ],
            project_access_grants: [
                {
                    id: "g-u1",
                    project_id: "p-other",
                    email: "u1@example.com",
                    role: "member",
                },
                {
                    id: "g-keep",
                    project_id: "p-other",
                    email: "keep@example.com",
                    role: "viewer",
                },
            ],
            tabular_review_access_grants: [
                {
                    id: "rg-u1",
                    tabular_review_id: "r-other",
                    email: "u1@example.com",
                    role: "member",
                },
                {
                    id: "rg-keep",
                    tabular_review_id: "r-other",
                    email: "keep@example.com",
                    role: "viewer",
                },
            ],
            tabular_reviews: [
                { id: "r1", user_id: "u1" },
                { id: "r-other", user_id: "u2" },
            ],
            documents: [
                { id: "d1", user_id: "u1", project_id: null },
                // Guest doc uploaded by another user into u1's project: deleted too.
                { id: "d-guest", user_id: "u2", project_id: "p1" },
                { id: "d-other", user_id: "u2", project_id: "p-other" },
            ],
            document_versions: [
                {
                    id: "v1",
                    document_id: "d1",
                    storage_path: "documents/u1/d1/source.pdf",
                    pdf_storage_path: "documents/u1/d1/converted.pdf",
                },
                {
                    id: "v-guest",
                    document_id: "d-guest",
                    storage_path: "documents/u2/d-guest/source.docx",
                    pdf_storage_path: null,
                },
                {
                    id: "v-other",
                    document_id: "d-other",
                    storage_path: "documents/u2/d-other/source.pdf",
                    pdf_storage_path: null,
                },
            ],
            chats: [
                { id: "c1", user_id: "u1" },
                { id: "c-other", user_id: "u2" },
            ],
            chat_access_grants: [
                {
                    id: "cg-u1",
                    chat_id: "c-other",
                    email: "u1@example.com",
                    role: "member",
                },
                {
                    id: "cg-keep",
                    chat_id: "c-other",
                    email: "keep@example.com",
                    role: "viewer",
                },
            ],
            tabular_review_chats: [{ id: "rc1", user_id: "u1" }],
            project_subfolders: [{ id: "f1", user_id: "u1" }],
            hidden_workflows: [{ id: "h1", user_id: "u1" }],
            workflow_open_source_submissions: [
                { id: "s1", submitted_by_user_id: "u1" },
            ],
            workflow_shares: [
                { id: "ws-by", shared_by_user_id: "u1", shared_with_email: "x@y.z" },
                {
                    id: "ws-to",
                    shared_by_user_id: "u2",
                    shared_with_email: "u1@example.com",
                },
                {
                    id: "ws-keep",
                    shared_by_user_id: "u2",
                    shared_with_email: "keep@example.com",
                },
            ],
            workflows: [
                { id: "w1", user_id: "u1" },
                { id: "w-other", user_id: "u2" },
            ],
            audit_events: [
                { id: "a1", user_id: "u1" },
                { id: "a2", user_id: "u1" },
                { id: "a-other", user_id: "u2" },
            ],
            memory_files: [
                {
                    id: "memory-u1",
                    scope: "user",
                    user_id: "u1",
                    enabled: true,
                },
                {
                    id: "memory-p1",
                    scope: "project",
                    project_id: "p1",
                    enabled: true,
                },
                {
                    id: "memory-p-other",
                    scope: "project",
                    project_id: "p-other",
                    enabled: true,
                },
            ],
            memory_file_versions: [
                {
                    id: "memory-version-u1",
                    memory_file_id: "memory-u1",
                    storage_path:
                        "memories/users/u1/versions/v1/memory.md",
                },
                {
                    id: "memory-version-p1",
                    memory_file_id: "memory-p1",
                    storage_path:
                        "memories/projects/p1/versions/v1/memory.md",
                },
                {
                    id: "memory-version-p-other",
                    memory_file_id: "memory-p-other",
                    storage_path:
                        "memories/projects/p-other/versions/v1/memory.md",
                },
            ],
        }, options);

    it("removes the user's rows, files, and share references everywhere", async () => {
        const { db, tables } = fixture();
        listFilesMock.mockImplementation(async (prefix: string) =>
            prefix === "documents/u1/"
                ? ["documents/u1/orphan.bin"]
                : prefix === "exports/u1/"
                  ? ["exports/u1/e1-account.json"]
                  : prefix === "memories/users/u1/"
                    ? ["memories/users/u1/versions/orphan/memory.md"]
                  : [],
        );

        await deleteUserAccountData(db, "u1", " U1@Example.COM ");

        // Owned docs and guest docs inside owned projects are gone.
        expect(ids(tables.documents)).toEqual(["d-other"]);
        expect(ids(tables.projects)).toEqual(["p-other"]);
        expect(ids(tables.chats)).toEqual(["c-other"]);
        expect(tables.tabular_review_chats).toEqual([]);
        expect(ids(tables.tabular_reviews)).toEqual(["r-other"]);
        expect(tables.project_subfolders).toEqual([]);
        expect(tables.hidden_workflows).toEqual([]);
        expect(tables.workflow_open_source_submissions).toEqual([]);
        expect(ids(tables.workflows)).toEqual(["w-other"]);

        // Audit rows carry PII (email, titles, prompt excerpts) and must be
        // purged on account deletion — only the other user's row survives.
        expect(ids(tables.audit_events)).toEqual(["a-other"]);

        // Private app memory and personal-project memory are fenced and
        // queued for object deletion before their owner rows cascade. A
        // colleague's surviving project memory is not this account's data.
        expect(ids(tables.memory_file_versions)).toEqual([
            "memory-version-p-other",
        ]);
        expect(
            (tables.db_jobs ?? [])
                .filter((job) => job.kind === "storage.cleanup")
                .flatMap((job) =>
                    ((job.payload as { keys?: string[] })?.keys ?? []),
                )
                .sort(),
        ).toEqual([
            "memories/projects/p1/versions/v1/memory.md",
            "memories/users/u1/versions/v1/memory.md",
        ]);

        // Shares by the user and shares to the user's email are both removed.
        expect(ids(tables.workflow_shares)).toEqual(["ws-keep"]);

        // The user's project access grants are revoked and other
        // collaborators' grants are preserved.
        expect(
            tables.project_access_grants.map((row) => row.id),
        ).toEqual(["g-keep"]);
        expect(
            tables.tabular_review_access_grants.map((row) => row.id),
        ).toEqual(["rg-keep"]);
        expect(tables.chat_access_grants.map((row) => row.id)).toEqual([
            "cg-keep",
        ]);

        // Version files for deleted docs plus orphans under the user's prefix.
        const deletedPaths = deleteFileMock.mock.calls.map(([path]) => path);
        expect(deletedPaths.sort()).toEqual([
            "documents/u1/d1/converted.pdf",
            "documents/u1/d1/source.pdf",
            "documents/u1/orphan.bin",
            "documents/u2/d-guest/source.docx",
            // Export artifacts hold a full copy of the account's data;
            // erasure must purge them with the rest.
            "exports/u1/e1-account.json",
            // Version-id-keyed text caches: not under any user prefix, so
            // account erasure would leak them without this.
            "extracted-text/v-guest.txt",
            "extracted-text/v1.txt",
            // Account erasure also catches immutable memory candidates that
            // were never committed to version metadata.
            "memories/users/u1/versions/orphan/memory.md",
        ]);
        expect(listFilesMock).toHaveBeenCalledWith("documents/u1/");
        expect(listFilesMock).toHaveBeenCalledWith("exports/u1/");
        expect(listFilesMock).toHaveBeenCalledWith("memories/users/u1/");
    });

    it("treats document/workflow prefix cleanup as best-effort", async () => {
        const { db, tables } = fixture();
        // Orphan sweep failing is tolerable: version-linked files were
        // already deleted (throwing) via the document_versions walk.
        listFilesMock.mockImplementation(async (prefix: string) => {
            if (
                prefix === "exports/u1/" ||
                prefix === "memories/users/u1/"
            )
                return [];
            throw new Error("storage unavailable");
        });
        await expect(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        ).resolves.toBeUndefined();
        expect(ids(tables.documents)).toEqual(["d-other"]);
    });

    // The exports/ prefix is different in kind from the orphan sweep: each
    // object under it is a complete copy of the account's data, and once the
    // account.delete job purges the user's db_jobs rows this listing is the
    // last enumeration of those objects anywhere. A swallowed failure here
    // means the deletion "succeeds" while a full export survives with nothing
    // left to retry its removal — so failures must propagate and let the
    // durable job retry.
    it("propagates an export-prefix listing failure so the durable job retries", async () => {
        const { db } = fixture();
        listFilesMock.mockImplementation(async (prefix: string) => {
            if (prefix === "exports/u1/") throw new Error("storage unavailable");
            return [];
        });
        await expect(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        ).rejects.toThrow(/export/i);
    });

    it("propagates an export-artifact delete failure so the durable job retries", async () => {
        const { db } = fixture();
        listFilesMock.mockImplementation(async (prefix: string) =>
            prefix === "exports/u1/" ? ["exports/u1/e1-account.json"] : [],
        );
        deleteFileMock.mockImplementation(async (path: string) => {
            if (path === "exports/u1/e1-account.json")
                throw new Error("storage unavailable");
        });
        await expect(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        ).rejects.toThrow(/export/i);
    });

    it("propagates a memory-prefix listing failure so account erasure retries", async () => {
        const { db } = fixture();
        listFilesMock.mockImplementation(async (prefix: string) => {
            if (prefix === "memories/users/u1/") {
                throw new Error("storage unavailable");
            }
            return [];
        });
        await expect(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        ).rejects.toThrow(/memory/i);
    });

    it("propagates a memory-object delete failure so account erasure retries", async () => {
        const { db } = fixture();
        const path = "memories/users/u1/versions/orphan/memory.md";
        listFilesMock.mockImplementation(async (prefix: string) =>
            prefix === "memories/users/u1/" ? [path] : [],
        );
        deleteFileMock.mockImplementation(async (candidate: string) => {
            if (candidate === path) throw new Error("storage unavailable");
        });
        await expect(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        ).rejects.toThrow(/memory/i);
    });

    it("keeps every storage byte until the last doomed row is gone", async () => {
        // Nothing here is transactional. If any row deletion fails, the
        // request 500s and the account survives — so the bytes must still
        // be there for the retry. Files deleted BEFORE the rows meant a
        // mid-sequence failure left a live account whose every document
        // 404s. A failure injected into one of the by-user deletions must
        // now abort the cleanup with storage untouched.
        const { db, tables } = fixture({
            deleteErrors: { chats: "connection reset" },
        });

        await expect(
            deleteUserAccountData(db, "u1", "u1@example.com"),
        ).rejects.toThrow(/Failed to delete account data/);

        expect(deleteFileMock).not.toHaveBeenCalled();
        // The account's chats are still there for the retry to find.
        expect(ids(tables.chats)).toContain("c1");
    });

    it("skips share scrubbing when no email is known", async () => {
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);
        // Rows referencing the email by value are left in place...
        expect(
            tables.project_access_grants.map((row) => row.id),
        ).toEqual(["g-u1", "g-keep"]);
        expect(tables.chat_access_grants.map((row) => row.id)).toEqual([
            "cg-u1",
            "cg-keep",
        ]);
        expect(
            tables.tabular_review_access_grants.map((row) => row.id),
        ).toEqual(["rg-u1", "rg-keep"]);
        expect(ids(tables.workflow_shares)).toEqual(["ws-to", "ws-keep"]);
        // ...but the user's own data is still deleted.
        expect(ids(tables.documents)).toEqual(["d-other"]);
        expect(tables.workflows.map((row) => row.id)).toEqual(["w-other"]);
    });
});

// ---------------------------------------------------------------------------
// deleteUserAccountData — what the organization keeps
// ---------------------------------------------------------------------------

describe("deleteUserAccountData organization retention", () => {
    // u1 is leaving. u2 stays. "org-1" owns two projects: one u1 opened and
    // one u2 opened that u1 contributed to. Everything org-owned survives
    // with user_id blanked; everything personal is destroyed.
    const fixture = () =>
        makeDb({
            projects: [
                { id: "p-own-org", user_id: "u1", org_id: "org-1" },
                { id: "p-colleague", user_id: "u2", org_id: "org-1" },
                { id: "p-personal", user_id: "u1", org_id: null },
            ],
            documents: [
                { id: "d-own-org", user_id: "u1", project_id: "p-own-org", org_id: "org-1" },
                { id: "d-colleague", user_id: "u1", project_id: "p-colleague", org_id: "org-1" },
                { id: "d-loose-org", user_id: "u1", project_id: null, org_id: "org-1" },
                { id: "d-personal", user_id: "u1", project_id: "p-personal", org_id: null },
                { id: "d-loose-personal", user_id: "u1", project_id: null, org_id: null },
                // Workflow assets are documents rows since 20260901_03 —
                // deliberately with no org_id of their own, the shape legacy
                // migrated assets have: only workflow_id ties them to the
                // tenant.
                { id: "wa-org", user_id: "u1", project_id: null, org_id: null, workflow_id: "w-org" },
                { id: "wa-personal", user_id: "u1", project_id: null, org_id: null, workflow_id: "w-personal" },
            ],
            document_versions: [
                {
                    id: "v-colleague",
                    document_id: "d-colleague",
                    storage_path: "documents/u1/d-colleague/source.pdf",
                    pdf_storage_path: null,
                },
                {
                    id: "v-personal",
                    document_id: "d-personal",
                    storage_path: "documents/u1/d-personal/source.pdf",
                    pdf_storage_path: null,
                },
                {
                    id: "v-wa-org",
                    document_id: "wa-org",
                    storage_path: "workflow-references/u1/w-org/wr-org/abc.pdf",
                    pdf_storage_path: null,
                },
                {
                    id: "v-wa-personal",
                    document_id: "wa-personal",
                    storage_path:
                        "workflow-references/u1/w-personal/wr-personal/def.pdf",
                    pdf_storage_path: null,
                },
            ],
            chats: [
                { id: "ch-colleague", user_id: "u1", project_id: "p-colleague" },
                { id: "ch-personal", user_id: "u1", project_id: null },
            ],
            project_subfolders: [
                { id: "f-colleague", user_id: "u1", project_id: "p-colleague" },
                { id: "f-personal", user_id: "u1", project_id: "p-personal" },
            ],
            tabular_reviews: [
                { id: "r-org", user_id: "u1", project_id: "p-colleague", org_id: "org-1" },
                { id: "r-personal", user_id: "u1", project_id: null, org_id: null },
            ],
            tabular_review_chats: [
                { id: "rc-org", user_id: "u1", review_id: "r-org" },
                { id: "rc-personal", user_id: "u1", review_id: "r-personal" },
            ],
            workflows: [
                { id: "w-org", user_id: "u1", org_id: "org-1" },
                { id: "w-personal", user_id: "u1", org_id: null },
            ],
        });

    const row = (rows: Row[] | undefined, id: string) =>
        (rows ?? []).find((candidate) => candidate.id === id);

    it("keeps the leaver's content inside a COLLEAGUE's org project", async () => {
        // The case the first cut missed: retention keyed on "org projects
        // this user created", so a departing associate's uploads into a
        // partner's matter were deleted with their account.
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);

        expect(row(tables.documents, "d-colleague")).toMatchObject({
            user_id: null,
            project_id: "p-colleague",
        });
        expect(row(tables.chats, "ch-colleague")?.user_id).toBeNull();
        expect(row(tables.project_subfolders, "f-colleague")?.user_id).toBeNull();
        expect(row(tables.tabular_reviews, "r-org")?.user_id).toBeNull();

        // And the colleague's own project does NOT change hands.
        expect(row(tables.projects, "p-colleague")?.user_id).toBe("u2");
    });

    it("detaches the org projects the leaver created, contents included", async () => {
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);

        expect(row(tables.projects, "p-own-org")?.user_id).toBeNull();
        expect(row(tables.documents, "d-own-org")?.user_id).toBeNull();
    });

    it("keeps org-tagged content that sits outside any project", async () => {
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);

        expect(row(tables.documents, "d-loose-org")?.user_id).toBeNull();
    });

    it("keeps org workflows and the asset documents they depend on", async () => {
        // documents.workflow_id cascades from workflows, so a surviving org
        // workflow whose assets were deleted with their uploader would still
        // be there and no longer work. The asset carries no org_id of its
        // own (the migrated legacy shape) — the workflow's org is the claim.
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);

        expect(row(tables.workflows, "w-org")?.user_id).toBeNull();
        expect(row(tables.documents, "wa-org")?.user_id).toBeNull();
    });

    it("keeps the review chat attached to a surviving org review", async () => {
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);

        expect(row(tables.tabular_review_chats, "rc-org")?.user_id).toBeNull();
    });

    it("still destroys everything personal", async () => {
        const { db, tables } = fixture();
        await deleteUserAccountData(db, "u1", null);

        expect(row(tables.projects, "p-personal")).toBeUndefined();
        expect(row(tables.documents, "d-personal")).toBeUndefined();
        expect(row(tables.documents, "d-loose-personal")).toBeUndefined();
        expect(row(tables.chats, "ch-personal")).toBeUndefined();
        expect(row(tables.project_subfolders, "f-personal")).toBeUndefined();
        expect(row(tables.tabular_reviews, "r-personal")).toBeUndefined();
        expect(row(tables.tabular_review_chats, "rc-personal")).toBeUndefined();
        expect(row(tables.workflows, "w-personal")).toBeUndefined();
        expect(row(tables.documents, "wa-personal")).toBeUndefined();
    });

    it("deletes storage only for the documents it actually destroys", async () => {
        const { db } = fixture();
        await deleteUserAccountData(db, "u1", null);

        const deleted = deleteFileMock.mock.calls.map(([path]) => path);
        expect(deleted).toContain("documents/u1/d-personal/source.pdf");
        expect(deleted).not.toContain("documents/u1/d-colleague/source.pdf");
    });

    it("leaves the bytes of every row the organization keeps", async () => {
        // Storage keys are namespaced by the UPLOADER, not the owner:
        // documents/{uploaderId}/{documentId}/…. So the leaver's prefix holds
        // the bytes of documents the firm is deliberately KEEPING, and a
        // blanket "delete documents/u1/" destroyed them while their rows
        // survived — a matter full of documents whose every version 404s.
        const { db } = fixture();
        // Prefix-exact on purpose: main's export-artifact cleanup sweeps
        // exports/u1/ too, and a mock that answers every prefix with the
        // workflow files would hand them to that sweep as its own.
        listFilesMock.mockImplementation(async (prefix: string) => {
            if (prefix === "documents/u1/")
                return [
                    "documents/u1/d-colleague/source.pdf",
                    "documents/u1/d-personal/source.pdf",
                    "documents/u1/interrupted-upload.bin",
                ];
            if (prefix === "workflow-references/u1/")
                return [
                    "workflow-references/u1/w-org/wr-org/abc.pdf",
                    "workflow-references/u1/w-personal/wr-personal/def.pdf",
                ];
            return [];
        });

        await deleteUserAccountData(db, "u1", null);
        const deleted = deleteFileMock.mock.calls.map(([path]) => path);

        // Kept by the organization — a surviving row still points at these.
        expect(deleted).not.toContain("documents/u1/d-colleague/source.pdf");
        expect(deleted).not.toContain(
            "workflow-references/u1/w-org/wr-org/abc.pdf",
        );
        // Destroyed with the account, or claimed by nothing at all.
        expect(deleted).toContain("documents/u1/d-personal/source.pdf");
        expect(deleted).toContain(
            "workflow-references/u1/w-personal/wr-personal/def.pdf",
        );
        expect(deleted).toContain("documents/u1/interrupted-upload.bin");
    });
});
