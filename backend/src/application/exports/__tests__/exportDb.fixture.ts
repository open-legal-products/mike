export type Row = Record<string, unknown>;

// Read-only fake supporting the query subset the exports use
// (select/eq/neq/is/not/in/filter/order/limit/gt + thenable). Like a real
// table, every row has an id (the paging key); like a real gateway, a
// response is silently capped at `maxRows`.
export function makeExportDb(
    tables: Record<string, Row[]>,
    errors: Record<string, { message: string }> = {},
    { maxRows = 1000 }: { maxRows?: number } = {},
) {
    const reads: string[] = [];
    function query(table: string) {
        // Read at query time: a test may edit `tables` between exports.
        let rows = (tables[table] ?? []).map((row, index) =>
            row.id === undefined ? { id: `${table}-${index + 1}`, ...row } : row,
        );
        const orders: Array<[string, boolean]> = [];
        let limit = Infinity;
        const error = errors[table] ?? null;
        const compare = (left: unknown, right: unknown) =>
            left === right ? 0 : String(left ?? "") < String(right ?? "") ? -1 : 1;
        const builder: any = {
            select: () => builder,
            order: (col: string, options?: { ascending?: boolean }) => {
                orders.push([col, options?.ascending !== false]);
                return builder;
            },
            limit: (count: number) => {
                limit = count;
                return builder;
            },
            eq: (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] === val);
                return builder;
            },
            neq: (col: string, val: unknown) => {
                rows = rows.filter((r) => r[col] !== val);
                return builder;
            },
            gt: (col: string, val: unknown) => {
                rows = rows.filter((r) => compare(r[col], val) > 0);
                return builder;
            },
            is: (col: string, val: unknown) => {
                rows = rows.filter((r) => (r[col] ?? null) === val);
                return builder;
            },
            not: (col: string, op: string, val: unknown) => {
                if (op === "is" && val === null)
                    rows = rows.filter((r) => (r[col] ?? null) !== null);
                return builder;
            },
            in: (col: string, vals: unknown[]) => {
                rows = rows.filter((r) => vals.includes(r[col]));
                return builder;
            },
            filter: (col: string, op: string, value: string) => {
                reads.push(`${table}.${col}:${op}`);
                if (op !== "cs") return builder;
                const expected = JSON.parse(value) as string[];
                rows = rows.filter((r) => {
                    const actual = r[col];
                    return (
                        Array.isArray(actual) &&
                        expected.every((item) => actual.includes(item))
                    );
                });
                return builder;
            },
            maybeSingle: async () => ({ data: error ? null : rows[0] ?? null, error }),
            single: async () => ({ data: error ? null : rows[0] ?? null, error }),
            then: (
                resolve: (v: { data: Row[] | null; error: { message: string } | null }) => unknown,
                reject?: (e: unknown) => unknown,
            ) => {
                const sorted = [...rows].sort((a, b) => {
                    for (const [col, ascending] of orders) {
                        const result = compare(a[col], b[col]);
                        if (result !== 0) return ascending ? result : -result;
                    }
                    return 0;
                });
                const data = sorted.slice(0, Math.min(limit, maxRows));
                return Promise.resolve({ data: error ? null : data, error }).then(resolve, reject);
            },
        };
        return builder;
    }
    return { db: { from: (t: string) => query(t) } as any, reads };
}
