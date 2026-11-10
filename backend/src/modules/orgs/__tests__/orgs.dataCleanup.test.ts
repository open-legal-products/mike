import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
    deleteFilesBestEffort: vi.fn(async () => undefined),
    // The inline cleanup fallback (DB_JOBS_ENABLED=false) deletes one key at a time.
    assertStorageConfigured: vi.fn(),
    deleteFile: vi.fn(async () => undefined),
    extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));

vi.mock("../../../lib/dbq/enqueue", async (original) => ({
    ...(await original<typeof import("../../../lib/dbq/enqueue")>()),
    requestDocumentCleanupDelivery: vi.fn(async () => {}),
}));

import { deleteFile, deleteFilesBestEffort } from "../../../lib/storage";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import { deleteOrgMemories, deleteOrgPlaybooks, deleteOrgWorkflows } from "../orgs.dataCleanup";

type Row = Record<string, unknown>;

/** Stateful fake for the select/delete + eq/neq/in/limit chains used here. */
function makeDb(initial: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = {};
    for (const [name, rows] of Object.entries(initial))
        tables[name] = rows.map((row) => ({ ...row }));

    function from(table: string) {
        const filters: ((row: Row) => boolean)[] = [];
        let mode: "select" | "delete" = "select";
        const builder: any = {
            select: () => builder,
            limit: () => builder,
            delete: () => {
                mode = "delete";
                return builder;
            },
            eq: (col: string, val: unknown) => {
                filters.push((row) => row[col] === val);
                return builder;
            },
            neq: (col: string, val: unknown) => {
                filters.push((row) => row[col] !== val);
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                filters.push((row) => vals.includes(row[col]));
                return builder;
            },
            then: (resolve: (value: unknown) => unknown) => {
                const rows = tables[table] ?? [];
                const matched = rows.filter((row) => filters.every((f) => f(row)));
                if (mode === "delete") {
                    tables[table] = rows.filter((row) => !matched.includes(row));
                    if (table === "playbooks") {
                        const ids = matched.map((row) => row.id);
                        tables.playbook_sources = (tables.playbook_sources ?? []).filter(
                            (row) => !ids.includes(row.playbook_id),
                        );
                    }
                }
                return Promise.resolve({ data: matched, error: null }).then(resolve);
            },
        };
        return builder;
    }
    return { db: { from } as any, tables };
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(deleteFilesBestEffort).mockClear();
});

describe("deleteOrgPlaybooks", () => {
    it("deletes the organization's playbooks, their files and finished imports", async () => {
        vi.stubEnv("DB_JOBS_ENABLED", "false");
        const { db, tables } = makeDb({
            playbooks: [
                { id: "pb-public", org_id: "org-1", source_storage_key: "playbooks/u1/pb-public/source.docx" },
                { id: "pb-private", org_id: "org-1", source_storage_key: null },
                { id: "pb-elsewhere", org_id: "org-2", source_storage_key: "playbooks/u2/pb-elsewhere/source.docx" },
            ],
            playbook_sources: [
                { id: "src", playbook_id: "pb-private", storage_key: "playbooks/u2/pb-private/sources/src.pdf" },
            ],
            playbook_imports: [
                { id: "import-done", org_id: "org-1", status: "completed" },
                { id: "import-running", org_id: "org-1", status: "running" },
                { id: "import-elsewhere", org_id: "org-2", status: "failed" },
            ],
        });

        await expect(deleteOrgPlaybooks(db, "org-1")).resolves.toBe(2);

        expect(tables.playbooks.map((row) => row.id)).toEqual(["pb-elsewhere"]);
        expect(tables.playbook_sources).toEqual([]);
        expect(tables.playbook_imports.map((row) => row.id)).toEqual([
            "import-running",
            "import-elsewhere",
        ]);
        const keys = vi.mocked(deleteFilesBestEffort).mock.calls.flatMap(
            ([batch]) => [...batch],
        );
        expect(keys.sort()).toEqual([
            "playbooks/u1/pb-public/source.docx",
            "playbooks/u2/pb-private/sources/src.pdf",
        ]);
    });
});

it("deletes an organization's workflows and wipes its memory in batches, not per row", async () => {
    const fake = tableDb({
        workflows: Array.from({ length: 120 }, (_, i) => ({ id: `w${String(i).padStart(3, "0")}`, org_id: "org" })),
        memory_files: Array.from({ length: 70 }, (_, i) => ({ id: `m${String(i).padStart(3, "0")}`, scope: "user", org_id: "org" })),
        projects: [],
        documents: [],
    });
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: null, error: null }));
    const db = { from: fake.db.from, rpc } as never;

    expect(await deleteOrgWorkflows(db, "org")).toBe(120);
    await deleteOrgMemories(db, "org");

    expect(fake.tables.workflows).toEqual([]);
    expect(fake.calls.filter((call) => call.table === "workflows" && call.op === "delete")).toHaveLength(3);
    // One set-wipe per 50 files (wipe_memory_files, the set form of wipe_memory_file).
    expect(rpc.mock.calls.map(([name, args]) => [name, (args.p_ids as string[]).length])).toEqual([
        ["wipe_memory_files", 50],
        ["wipe_memory_files", 20],
    ]);
});

it("hands every workflow attachment to inline cleanup and finishes when storage refuses some", async () => {
    vi.stubEnv("DB_JOBS_ENABLED", "false");
    const workflows = ["w1", "w2", "w3"].map((id) => ({ id, org_id: "org" }));
    const documents = workflows.flatMap(({ id }) => [1, 2].map((n) => ({ id: `${id}-d${n}`, workflow_id: id })));
    const fake = tableDb({
        workflows,
        documents,
        document_versions: documents.map((doc) => ({ id: `v-${doc.id}`, document_id: doc.id, storage_path: `${doc.id}.docx`, pdf_storage_path: null })),
        projects: [],
    }, { maxRows: 3, cascade: { workflows: [["documents", "workflow_id"]] } });
    const rpc = vi.fn(async (name: string) => ({ data: name === "document_cache_writer_active" ? false : [], error: null }));
    const db = { from: fake.db.from, rpc } as never;
    // The object store refuses one original; the rest must still be deleted.
    vi.mocked(deleteFile).mockImplementation(async (key: string) => {
        if (key === "w2-d1.docx") throw new Error("storage unavailable");
    });

    await expect(deleteOrgWorkflows(db, "org")).resolves.toBe(3);

    expect(fake.tables.workflows).toEqual([]);
    const attempted = vi.mocked(deleteFile).mock.calls.map(([key]) => key);
    // All six originals (and their text caches) were handed off, past the
    // 3-row response cap, including after the refused one.
    expect(attempted.filter((key) => key.endsWith(".docx")).sort()).toEqual(documents.map((doc) => `${doc.id}.docx`).sort());
    expect(attempted.filter((key) => key.startsWith("extracted-text/"))).toHaveLength(6);
});
