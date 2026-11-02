import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/storage", () => ({
    deleteFilesBestEffort: vi.fn(async () => undefined),
}));

import { deleteFilesBestEffort } from "../../../lib/storage";
import { deleteOrgPlaybooks } from "../orgs.dataCleanup";

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
