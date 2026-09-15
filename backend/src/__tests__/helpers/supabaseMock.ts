/**
 * Configurable Supabase stub shared by the route integration suites.
 *
 * Every suite that imports `../../app` loads *every* router, so each one needs
 * the same fake `createServerSupabase()`. The stub used to be copy-pasted
 * byte-for-byte into projects.routes.test.ts, tabular.routes.test.ts and
 * workflows.routes.test.ts; a fix to one copy (say, a newly-used PostgREST
 * filter method) silently left the other two behind.
 *
 * How it works: `supabaseState` is seeded per-test in `beforeEach`; terminal
 * query operations (.single() / .maybeSingle() / awaiting the thenable builder)
 * resolve to the per-table result, and rpc() resolves to `supabaseState.rpc`.
 * Insert payloads are recorded so tests can assert on what got persisted
 * (normalisation, lowercasing, dedupe), and `operations` / `rpcCalls` record
 * the order a route touched tables and RPCs in — the tabular suites assert on
 * that ordering to pin the generation-lease protocol (claim the lease before
 * reading rows, release it last).
 *
 * Usage — note that `vi.mock` factories are hoisted above imports, so the
 * factory must pull the helper in dynamically rather than closing over a
 * top-level import binding:
 *
 *     import { supabaseState, resetSupabaseState, mockSupabase } from "../helpers/supabaseMock";
 *
 *     vi.mock("../../lib/supabase", async () => {
 *         const { mockSupabase } = await import("../helpers/supabaseMock");
 *         return { createServerSupabase: vi.fn(() => mockSupabase()) };
 *     });
 *
 * The dynamic import inside the factory and the static import at the top of the
 * suite resolve to the same module instance, so the state object the tests
 * mutate is the one the stub reads. Vitest isolates modules per test file, so
 * the module-level state is per-suite, not shared across files.
 */
import { vi } from "vitest";

export type QueryResult = { data: unknown; error: unknown };

export type SupabaseState = {
    rpc: QueryResult;
    /** `from:<table>` / `rpc:<fn>` in call order. */
    operations: string[];
    rpcCalls: { fn: string; args: unknown }[];
    tables: Record<string, QueryResult>;
    inserts: { table: string; payload: unknown }[];
};

/**
 * Reset in place rather than reassigned, so suites can hold a stable reference
 * to this object across `resetSupabaseState()` calls in `beforeEach`.
 */
export const supabaseState: SupabaseState = {
    rpc: { data: [], error: null },
    operations: [],
    rpcCalls: [],
    tables: {},
    inserts: [],
};

export function resetSupabaseState() {
    supabaseState.rpc = { data: [], error: null };
    supabaseState.operations = [];
    supabaseState.rpcCalls = [];
    supabaseState.tables = {};
    supabaseState.inserts = [];
}

function resultForTable(table: string): QueryResult {
    return supabaseState.tables[table] ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    const chain = [
        "select",
        "update",
        "delete",
        "upsert",
        "eq",
        "neq",
        "in",
        "is",
        "or",
        "not",
        "lt",
        "gt",
        "gte",
        "lte",
        "filter",
        "order",
        "limit",
        "range",
        "contains",
    ];
    for (const m of chain) q[m] = vi.fn(() => q);
    q.insert = vi.fn((payload: unknown) => {
        supabaseState.inserts.push({ table, payload });
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.maybeSingle = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.then = (
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
    ) => Promise.resolve(resultForTable(table)).then(resolve, reject);
    return q;
}

/**
 * The stub client. `rpc` is declared with its real (name, args) parameters —
 * not zero-arity — because suites wrap it to capture the arguments a route
 * actually sent (see `captureRpcArgs` in projects/workflows routes tests).
 */
export type SupabaseStub = {
    from: (table: string) => Record<string, unknown>;
    rpc: (name: string, args?: unknown) => Promise<QueryResult>;
    auth: {
        getUser: () => Promise<{
            data: { user: { id: string } };
            error: null;
        }>;
    };
};

export function mockSupabase(): SupabaseStub {
    return {
        from: vi.fn((table: string) => {
            supabaseState.operations.push(`from:${table}`);
            return makeQuery(table);
        }),
        rpc: vi.fn((name: string, args?: unknown) => {
            supabaseState.operations.push(`rpc:${name}`);
            supabaseState.rpcCalls.push({ fn: name, args });
            return Promise.resolve(supabaseState.rpc);
        }),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    };
}
