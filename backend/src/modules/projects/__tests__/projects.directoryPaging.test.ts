import { expect, it, vi } from "vitest";
vi.mock("../../../lib/storage", () => ({}));
import { loadProjectDirectoryChildren } from "../projects.crud";
import type { Db } from "../../../lib/supabase";
it("retrieves every child under a low gateway cap with bounded ID filters and keyset pages", async () => {
    const rows = Array.from({ length: 150 }, (_, n) => ({ id: String(n).padStart(4, "0"), project_id: `p${n % 75}` }));
    const batches: string[][] = [];
    const db = { from: () => {
        let ids: string[] = [], after = "";
        const query = { select: () => query, in: (_key: string, value: string[]) => { ids = value; batches.push(value); return query; }, order: () => query, limit: () => query, gt: (_key: string, value: string) => { after = value; return query; },
            then: (resolve: (result: unknown) => unknown) => Promise.resolve({ data: rows.filter(row => ids.includes(row.project_id) && row.id > after).slice(0, 17), error: null }).then(resolve) };
        return query;
    } } as unknown as Db;
    const result = await loadProjectDirectoryChildren(db, "documents", Array.from({ length: 75 }, (_, n) => `p${n}`));
    expect(result.data).toEqual(rows);
    expect(batches.every(batch => batch.length <= 50)).toBe(true);
});
