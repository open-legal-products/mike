import { describe, it, expect, vi, afterEach } from "vitest";

const { redisEnabled, reportError, redisConnect } = vi.hoisted(() => ({
    redisEnabled: vi.fn(() => false),
    reportError: vi.fn(),
    redisConnect: vi.fn(),
}));
vi.mock("../../../lib/dbq/driver", () => ({
    redisEnabled: () => redisEnabled(),
}));
vi.mock("../../../lib/observability/sentry", async (importOriginal) => ({
    ...(await importOriginal<
        typeof import("../../../lib/observability/sentry")
    >()),
    reportError,
}));
// A subscriber whose connection fails the way a down or misconfigured Redis
// does: the constructor throws.
vi.mock("ioredis", () => ({
    default: class {
        constructor() {
            redisConnect();
        }
    },
}));

import { EventEmitter } from "node:events";
import { AppError } from "../../../lib/appError";
import { tableDb } from "../../../__tests__/helpers/tableDb";
import {
    awaitCellTerminal,
    streamTabularRunView,
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

    it("falls back to the DB poll and reports a failed subscribe under its kind", async () => {
        process.env.ASYNC_TABULAR_EXTRACTION = "true";
        redisEnabled.mockReturnValue(true);
        const cause = Object.assign(new Error("connect refused"), {
            code: "ECONNREFUSED",
        });
        redisConnect.mockImplementation(() => {
            throw cause;
        });
        const log = { error: vi.fn() };
        const db = makeCellDb([
            { status: "done", content: JSON.stringify({ summary: "x" }) },
        ]);

        const terminal = await awaitCellTerminal({
            db: db as never,
            ...WAIT_ARGS,
            log,
            timeoutMs: 1_000,
        });

        // Degraded, not failed: the backstop still resolved the cell.
        expect(terminal).toEqual({
            status: "done",
            content: { summary: "x", flag: undefined, reasoning: "" },
        });
        expect(reportError).toHaveBeenCalledTimes(1);
        const [reported] = reportError.mock.calls[0];
        expect(reported).toBeInstanceOf(AppError);
        expect(reported.kind).toBe("tabular.stream_failed");
        expect(reported.cause).toBe(cause);
        // The log carries the reported object; the bridge files it once.
        expect(log.error).toHaveBeenCalledWith(
            "[tabular/regenerate-async] subscribe failed",
            expect.objectContaining({ err: reported }),
        );
        redisEnabled.mockReturnValue(false);
        redisConnect.mockReset();
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

describe("run-view reconcile poll", () => {
    it("re-reads only the pending rows' finished cells, not the whole review", async () => {
        vi.useFakeTimers();
        try {
            const rows = Array.from({ length: 40 }, (_, r) => ({ id: `row-${r}` }));
            const cells = rows.flatMap((row, r) => [0, 1].map((c) => ({
                id: `cell-${String(r * 2 + c).padStart(3, "0")}`, review_id: "rev", row_id: row.id,
                column_index: c, status: "done", content: JSON.stringify({ summary: "x" }),
            })));
            // The view started while row-39 column 1 was still pending.
            const cellMap = new Map(cells.map((cell) => [`${cell.row_id}:${cell.column_index}`, { ...cell }]));
            cellMap.get("row-39:1")!.status = "generating";
            const fake = tableDb({ tabular_cells: cells });
            const writes: string[] = [];
            const res = Object.assign(new EventEmitter(), {
                setHeader: () => {}, flushHeaders: () => {}, writableEnded: false,
                write: (chunk: string) => (writes.push(chunk), true),
                end() { this.writableEnded = true; },
            });
            await streamTabularRunView({
                res: res as never, db: fake.db, reviewId: "rev", columns: COLUMNS,
                rows: rows as never, cellMap, log: { error: vi.fn() } as never,
            });
            await vi.advanceTimersByTimeAsync(3_000);
            expect(writes.some((w) => w.includes('"row_id":"row-39"'))).toBe(true);
            expect(writes.at(-1)).toBe("data: [DONE]\n\n");
            // Only the pending row's finished cells travel: no read of the
            // whole review, whatever number of pages the poll takes.
            // (just the one pending cell: the row's resolved column is not re-sent)
            expect(fake.calls.reduce((rows, c) => rows + c.returned, 0)).toBe(1);
            expect(fake.calls.every((c) => c.inSizes[0] === 1)).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("run-view reconcile poll pacing", () => {
    it("skips a tick while the previous reconcile is still reading", async () => {
        vi.useFakeTimers();
        try {
            let reads = 0;
            let release: () => void = () => {};
            const gate = new Promise<void>((resolve) => (release = resolve));
            const builder: Record<string, unknown> = {};
            for (const name of ["select", "eq", "in", "order", "limit", "gt"]) builder[name] = () => builder;
            builder.then = (resolve: (value: unknown) => unknown) => {
                reads++;
                return gate.then(() => resolve({ data: [], error: null }));
            };
            const db = { from: () => builder };
            const res = Object.assign(new EventEmitter(), {
                setHeader: () => {}, flushHeaders: () => {}, writableEnded: false,
                write: () => true, end() { this.writableEnded = true; },
            });
            await streamTabularRunView({
                res: res as never, db: db as never, reviewId: "rev", columns: COLUMNS,
                rows: ROWS as never, cellMap: new Map(), log: { error: vi.fn() } as never,
            });
            await vi.advanceTimersByTimeAsync(3_000 * 4);
            // The first tick's read never returned: the next three ticks wait.
            expect(reads).toBe(1);
            release();
            res.emit("close");
        } finally {
            vi.useRealTimers();
        }
    });
});
