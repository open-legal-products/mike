import { describe, it, expect, vi, afterEach } from "vitest";

import {
    awaitCellTerminal,
    targetPendingCells,
} from "../tabular.generateStream";

const COLUMNS = [
    { index: 0, name: "A", prompt: "a" },
    { index: 1, name: "B", prompt: "b" },
];
const ROWS = [{ id: "row-1" }, { id: "row-2" }];

function cellMapOf(entries: [string, Record<string, unknown>][]) {
    return new Map(entries);
}

describe("targetPendingCells", () => {
    it("treats every cell as pending when there are no cells yet", () => {
        const { rowIds, pending } = targetPendingCells(
            COLUMNS,
            ROWS,
            cellMapOf([]),
        );
        expect(rowIds).toEqual(["row-1", "row-2"]);
        expect([...pending].sort()).toEqual([
            "row-1:0",
            "row-1:1",
            "row-2:0",
            "row-2:1",
        ]);
    });

    it("excludes cells that are done with content, and drops fully-done rows", () => {
        const { rowIds, pending } = targetPendingCells(COLUMNS, ROWS, cellMapOf([
            ["row-1:0", { status: "done", content: "{}" }],
            ["row-1:1", { status: "done", content: "{}" }],
            ["row-2:0", { status: "done", content: "{}" }],
            // row-2:1 missing → still pending
        ]));
        // row-1 is fully done → not enqueued; row-2 has one outstanding column.
        expect(rowIds).toEqual(["row-2"]);
        expect([...pending]).toEqual(["row-2:1"]);
    });

    it("keeps a done-but-empty cell pending (content required, not just status)", () => {
        const { pending } = targetPendingCells(COLUMNS, [{ id: "row-1" }], cellMapOf([
            ["row-1:0", { status: "done", content: null }],
            ["row-1:1", { status: "error", content: null }],
        ]));
        expect([...pending].sort()).toEqual(["row-1:0", "row-1:1"]);
    });
});

// ---------------------------------------------------------------------------
// awaitCellTerminal — the "view" half of an async regenerate-cell.
// ---------------------------------------------------------------------------

// Read-only Supabase double: it records every call so the tests can assert the
// wait loop never writes (the worker owns the cell and its generation lease).
function makeCellDb(rows: Record<string, unknown>[]) {
    const calls: { op: string; filters: Record<string, unknown> }[] = [];
    let reads = 0;
    function from(_table: string) {
        const state = { op: "select", filters: {} as Record<string, unknown> };
        const b: Record<string, unknown> = {
            select() {
                return b;
            },
            update() {
                state.op = "update";
                return b;
            },
            eq(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            maybeSingle() {
                calls.push({ op: state.op, filters: { ...state.filters } });
                // Successive polls walk `rows`, so a test can start "still
                // generating" and then go terminal.
                const row = rows[Math.min(reads, rows.length - 1)] ?? null;
                reads += 1;
                return Promise.resolve({ data: row, error: null });
            },
        };
        return b;
    }
    return { calls, from };
}

const WAIT_ARGS = {
    reviewId: "rev-1",
    rowId: "row-1",
    columnIndex: 1,
    log: console,
    pollMs: 1,
};

describe("awaitCellTerminal", () => {
    afterEach(() => {
        delete process.env.ASYNC_TABULAR_EXTRACTION;
        vi.restoreAllMocks();
    });

    it("resolves from the DB backstop once the worker writes 'done'", async () => {
        const db = makeCellDb([
            { status: "generating", content: null },
            { status: "done", content: JSON.stringify({ summary: "hi" }) },
        ]);

        const terminal = await awaitCellTerminal({
            db: db as never,
            ...WAIT_ARGS,
            timeoutMs: 1_000,
        });

        expect(terminal).toEqual({
            status: "done",
            content: { summary: "hi", flag: undefined, reasoning: "" },
        });
        // Never writes: the worker owns the cell's terminal state and its lease.
        expect(db.calls.every((c) => c.op === "select")).toBe(true);
    });

    it("resolves 'error' when the worker's failure handler wins", async () => {
        const db = makeCellDb([{ status: "error", content: null }]);

        const terminal = await awaitCellTerminal({
            db: db as never,
            ...WAIT_ARGS,
            timeoutMs: 1_000,
        });

        expect(terminal).toEqual({ status: "error" });
    });

    it("returns null when the wait budget elapses (route answers 202)", async () => {
        const db = makeCellDb([{ status: "generating", content: null }]);

        const terminal = await awaitCellTerminal({
            db: db as never,
            ...WAIT_ARGS,
            timeoutMs: 20,
        });

        // null == "still running": the job (and the lease it holds) outlives
        // this request, so nothing here may finish either.
        expect(terminal).toBeNull();
        expect(db.calls.every((c) => c.op === "select")).toBe(true);
    });

    it("does not dial Redis in synchronous deployments", async () => {
        const db = makeCellDb([
            { status: "done", content: JSON.stringify({ summary: "x" }) },
        ]);

        await awaitCellTerminal({
            db: db as never,
            ...WAIT_ARGS,
            timeoutMs: 1_000,
        });

        // Flag unset above — the DB poll alone resolved it.
        expect(process.env.ASYNC_TABULAR_EXTRACTION).toBeUndefined();
    });
});
