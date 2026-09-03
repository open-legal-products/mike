// A minimal stand-in for the Supabase client, shared by the tabular service
// unit tests.
//
// Service functions take an explicit `Db`, so a test can hand them this object
// instead of a real client: every builder method returns the same chainable
// stub, and awaiting the chain (or calling `.single()`) resolves the result the
// test seeded for that table. Seeding an ARRAY gives one result per call in
// order, which is what a handler that reads the same table twice needs. Each
// settled chain and every `rpc()` is recorded, so a test can assert on the
// filters a guarded write carried — the lease-fencing `.eq("generation_id", …)`
// especially.

import type { Db } from "../tabular.shared";

export type QueryResult = { data: unknown; error: unknown };

export type RecordedCall = {
    table: string;
    op: "select" | "insert" | "update" | "delete";
    payload?: unknown;
    filters: Record<string, unknown>;
};

export type RecordedRpc = { fn: string; args: Record<string, unknown> };

export type FakeDbSpec = {
    /** Result per table. An array is consumed one entry per settled query. */
    tables?: Record<string, QueryResult | QueryResult[]>;
    /** Result per RPC. Default: `{ data: null, error: null }`. */
    rpc?: (fn: string, args: Record<string, unknown>) => QueryResult;
};

export type FakeDb = {
    db: Db;
    calls: RecordedCall[];
    rpcCalls: RecordedRpc[];
};

const EMPTY: QueryResult = { data: null, error: null };

export function makeFakeDb(spec: FakeDbSpec = {}): FakeDb {
    const calls: RecordedCall[] = [];
    const rpcCalls: RecordedRpc[] = [];
    const cursor: Record<string, number> = {};

    function resultFor(table: string): QueryResult {
        const seeded = spec.tables?.[table];
        if (seeded === undefined) return EMPTY;
        if (!Array.isArray(seeded)) return seeded;
        const index = cursor[table] ?? 0;
        cursor[table] = index + 1;
        // Past the end, the last seeded result repeats — a caller that only
        // cares about the first read need not enumerate every later one.
        return seeded[Math.min(index, seeded.length - 1)] ?? EMPTY;
    }

    function from(table: string) {
        const state: RecordedCall = { table, op: "select", filters: {} };
        const settle = () => {
            calls.push({ ...state, filters: { ...state.filters } });
            return Promise.resolve(resultFor(table));
        };
        const filter = (column: string, value: unknown) => {
            state.filters[column] = value;
            return builder;
        };
        const builder: Record<string, unknown> = {
            select: () => builder,
            insert: (payload: unknown) => {
                state.op = "insert";
                state.payload = payload;
                return builder;
            },
            upsert: (payload: unknown) => {
                state.op = "insert";
                state.payload = payload;
                return builder;
            },
            update: (payload: unknown) => {
                state.op = "update";
                state.payload = payload;
                return builder;
            },
            delete: () => {
                state.op = "delete";
                return builder;
            },
            eq: filter,
            neq: filter,
            in: filter,
            is: filter,
            not: filter,
            or: () => builder,
            order: () => builder,
            limit: () => builder,
            range: () => builder,
            single: () => settle(),
            maybeSingle: () => settle(),
            then: (
                onFulfilled?: (value: QueryResult) => unknown,
                onRejected?: (reason: unknown) => unknown,
            ) => settle().then(onFulfilled, onRejected),
        };
        return builder;
    }

    const rpc = (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve(spec.rpc ? spec.rpc(fn, args) : EMPTY);
    };

    return { db: { from, rpc } as unknown as Db, calls, rpcCalls };
}

/** The single call recorded against `table`, or the `index`-th of several. */
export function callTo(
    calls: RecordedCall[],
    table: string,
    index = 0,
): RecordedCall | undefined {
    return calls.filter((call) => call.table === table)[index];
}
