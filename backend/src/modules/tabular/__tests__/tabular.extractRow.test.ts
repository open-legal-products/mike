import { describe, it, expect, vi, beforeEach } from "vitest";

const queryTabularAllColumns = vi.fn();
vi.mock("../tabular.extract", () => ({
    queryTabularAllColumns: (...a: unknown[]) => queryTabularAllColumns(...a),
}));

const loadRowDocumentText = vi.fn();
vi.mock("../tabular.rows", () => ({
    loadRowDocumentText: (...a: unknown[]) => loadRowDocumentText(...a),
}));

import { extractRowColumns } from "../tabular.extractRow";
import type { ReviewRow } from "../tabular.rows";

type Call = {
    table: string;
    op: string;
    payload?: Record<string, unknown>;
    filters: Record<string, unknown>;
};
function makeDb() {
    const calls: Call[] = [];
    function from(table: string) {
        const state: Call = { table, op: "select", filters: {} };
        const b: Record<string, unknown> = {
            update(payload: Record<string, unknown>) {
                state.op = "update";
                state.payload = payload;
                return b;
            },
            insert(payload: Record<string, unknown>) {
                calls.push({ table, op: "insert", payload, filters: {} });
                return Promise.resolve({ data: null, error: null });
            },
            eq(col: string, val: unknown) {
                state.filters[col] = val;
                return b;
            },
            then(onF: (v: unknown) => unknown) {
                calls.push({ ...state, filters: { ...state.filters } });
                return Promise.resolve({ data: null, error: null }).then(onF);
            },
        };
        return b;
    }
    return { calls, from };
}

const COLUMNS = [
    { index: 0, name: "A", prompt: "a" },
    { index: 1, name: "B", prompt: "b" },
];
const ROW: ReviewRow = {
    id: "row-1",
    review_id: "rev-1",
    label: "Contract.pdf",
    row_type: "document",
    folder_id: null,
    library_folder_id: null,
    document_id: "doc-1",
    sort_index: 0,
    source_document_ids: ["doc-1"],
};
const RESULT = (i: number) => ({ summary: `c${i}`, flag: "green" as const, reasoning: "" });

function sinkSpy() {
    return {
        generating: vi.fn(),
        done: vi.fn(),
    };
}

beforeEach(() => {
    loadRowDocumentText.mockReset();
    loadRowDocumentText.mockResolvedValue("## Source document: Contract.pdf\ntext");
    queryTabularAllColumns.mockReset();
});

describe("extractRowColumns", () => {
    it("processes all columns, persists done, and reports none missing", async () => {
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, RESULT(c.index));
            },
        );
        const db = makeDb();
        const sink = sinkSpy();

        const out = await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: COLUMNS,
            existingByColumn: new Map(), // no cells yet
            model: "m",
            apiKeys: {},
            sink,
        });

        expect(out.processed).toHaveLength(2);
        expect([...out.received].sort()).toEqual([0, 1]);
        expect(out.missing).toEqual([]);
        // new cells are inserted with the row identity attached
        const inserts = db.calls.filter((c) => c.op === "insert");
        expect(inserts).toHaveLength(2);
        expect(inserts[0].payload).toMatchObject({
            review_id: "rev-1",
            row_id: "row-1",
            document_id: "doc-1",
        });
        expect(sink.generating).toHaveBeenCalledTimes(2);
        expect(sink.generating).toHaveBeenCalledWith("row-1", 0);
        expect(sink.done).toHaveBeenCalledTimes(2);
        // the LLM is prompted with the row's label and combined source text
        expect(queryTabularAllColumns.mock.calls[0][1]).toBe("Contract.pdf");
        expect(loadRowDocumentText).toHaveBeenCalledTimes(1);
    });

    it("skips columns already done with content (no LLM call, no text load)", async () => {
        const db = makeDb();
        const sink = sinkSpy();

        const out = await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: COLUMNS,
            existingByColumn: new Map([
                [0, { id: "c0", status: "done", content: "{}" }],
                [1, { id: "c1", status: "done", content: "{}" }],
            ]),
            model: "m",
            apiKeys: {},
            sink,
        });

        expect(out.processed).toHaveLength(0);
        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(loadRowDocumentText).not.toHaveBeenCalled();
        expect(sink.generating).not.toHaveBeenCalled();
    });

    it("reports columns the model omitted as missing without throwing", async () => {
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, _cols, onResult) => {
                await onResult(0, RESULT(0)); // only column 0 returns
            },
        );
        const db = makeDb();
        const sink = sinkSpy();

        const out = await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: COLUMNS,
            existingByColumn: new Map([
                [0, { id: "c0", status: "pending", content: null }],
                [1, { id: "c1", status: "pending", content: null }],
            ]),
            model: "m",
            apiKeys: {},
            sink,
        });

        expect(out.missing).toEqual([1]);
        expect(sink.done).toHaveBeenCalledTimes(1);
        // pre-existing cells → update (not insert) to mark generating
        expect(db.calls.filter((c) => c.op === "insert")).toHaveLength(0);
    });
});

describe("extractRowColumns generation isolation", () => {
    it("stamps every write with the generation id and guards the terminal one", async () => {
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols) await onResult(c.index, RESULT(c.index));
            },
        );
        const db = makeDb();
        const sink = sinkSpy();

        await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: COLUMNS,
            existingByColumn: new Map([
                [0, { id: "c0", status: "pending", content: null }],
            ]),
            model: "m",
            apiKeys: {},
            sink,
            generationId: "gen-1",
        });

        const generating = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "generating",
        );
        expect(generating).toHaveLength(1);
        expect(generating[0].payload?.generation_id).toBe("gen-1");
        // A brand-new cell carries the stamp from birth.
        const inserts = db.calls.filter((c) => c.op === "insert");
        expect(inserts).toHaveLength(1);
        expect(inserts[0].payload).toMatchObject({ generation_id: "gen-1" });

        const done = db.calls.filter(
            (c) => c.op === "update" && c.payload?.status === "done",
        );
        expect(done).toHaveLength(2);
        expect(
            done.every(
                (c) =>
                    c.payload?.generation_id === null &&
                    c.filters.generation_id === "gen-1",
            ),
        ).toBe(true);
    });

    it("leaves the grid untouched when aborted before the run starts", async () => {
        const db = makeDb();
        const sink = sinkSpy();
        const aborted = AbortSignal.abort();

        const out = await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: COLUMNS,
            existingByColumn: new Map(),
            model: "m",
            apiKeys: {},
            sink,
            abortSignal: aborted,
        });

        expect(out.missing).toEqual([]);
        expect(out.received.size).toBe(0);
        expect(db.calls).toHaveLength(0);
        expect(loadRowDocumentText).not.toHaveBeenCalled();
        expect(queryTabularAllColumns).not.toHaveBeenCalled();
        expect(sink.generating).not.toHaveBeenCalled();
    });

    // The interleaving the generation guards exist to survive. G1's snapshot
    // said "pending"; by the time G1 gets moving, G2 has taken the lease and
    // already written the answer. G1 must not be able to touch that cell —
    // and the dangerous write is the MARK, not the terminal one: marking
    // blanks `content` AND re-stamps the cell with G1's id, which then makes
    // G1's guarded terminal write match and overwrite the fresh result.
    it("a superseded generation cannot blank or overwrite the winner's cell", async () => {
        // Stateful cells table: one cell, already finished by G2.
        const rows = [
            {
                id: "c0",
                review_id: "rev-1",
                row_id: "row-1",
                column_index: 0,
                status: "done",
                content: JSON.stringify({ summary: "G2 WINNER" }),
                generation_id: null as string | null,
            },
        ];
        const db = {
            from() {
                const state: {
                    payload?: Record<string, unknown>;
                    filters: Record<string, unknown>;
                } = { filters: {} };
                const b: Record<string, unknown> = {
                    update(payload: Record<string, unknown>) {
                        state.payload = payload;
                        return b;
                    },
                    insert() {
                        return Promise.resolve({ data: null, error: null });
                    },
                    eq(col: string, val: unknown) {
                        state.filters[col] = val;
                        return b;
                    },
                    then(onF: (v: unknown) => unknown) {
                        if (state.payload)
                            for (const row of rows) {
                                const matches = Object.entries(
                                    state.filters,
                                ).every(
                                    ([col, val]) =>
                                        (row as Record<string, unknown>)[
                                            col
                                        ] === val,
                                );
                                if (matches) Object.assign(row, state.payload);
                            }
                        return Promise.resolve({
                            data: null,
                            error: null,
                        }).then(onF);
                    },
                };
                return b;
            },
        };

        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, cols, onResult) => {
                for (const c of cols)
                    await onResult(c.index, { summary: "G1 STALE" });
            },
        );

        await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: [COLUMNS[0]],
            // G1's stale snapshot: it believes the cell is still pending.
            existingByColumn: new Map([
                [0, { id: "c0", status: "pending", content: null }],
            ]),
            model: "m",
            apiKeys: {},
            sink: sinkSpy(),
            generationId: "gen-1",
        });

        expect(rows[0].status).toBe("done");
        expect(rows[0].content).toBe(JSON.stringify({ summary: "G2 WINNER" }));
        expect(rows[0].generation_id).toBeNull();
    });

    it("still reports unreturned columns when the stream is aborted mid-run", async () => {
        // The caller (the sync route) resets these to "pending" rather than
        // "error" — but it can only do that if they are reported as missing.
        const controller = new AbortController();
        queryTabularAllColumns.mockImplementation(
            async (_m, _f, _t, _cols, onResult) => {
                await onResult(0, RESULT(0));
                controller.abort();
                throw new Error("aborted");
            },
        );
        const db = makeDb();
        const sink = sinkSpy();

        const out = await extractRowColumns({
            db: db as never,
            reviewId: "rev-1",
            row: ROW,
            columns: COLUMNS,
            existingByColumn: new Map(),
            model: "m",
            apiKeys: {},
            sink,
            generationId: "gen-1",
            abortSignal: controller.signal,
        });

        expect(out.missing).toEqual([1]);
    });
});
