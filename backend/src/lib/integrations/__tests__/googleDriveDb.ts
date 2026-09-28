import type { Db } from "../../supabase";

type Row = Record<string, unknown>;
export function driveDb(
    options: {
        tokenRow?: Row | null;
        states?: Row[];
        onInsert?: (table: string, row: Row) => void;
        onDelete?: (table: string) => void;
    } = {},
) {
    const tokens: Row[] = options.tokenRow ? [options.tokenRow] : [];
    const states = options.states ?? [];
    const writes: { table: string; row: Row }[] = [];
    const failures = new Map<string, unknown>();
    const db = {
        from(table: string) {
            const rows = table === "user_google_drive_tokens" ? tokens : states;
            let action = "select";
            let patch: Row = {};
            let single = false;
            let limit = Infinity;
            const filters: ((row: Row) => boolean)[] = [];
            const query = {
                select() {
                    return query;
                },
                eq(key: string, value: unknown) {
                    filters.push((r) => r[key] === value);
                    return query;
                },
                gt(key: string, value: string) {
                    filters.push((r) => String(r[key]) > value);
                    return query;
                },
                lt(key: string, value: string) {
                    filters.push((r) => String(r[key]) < value);
                    return query;
                },
                limit(value: number) {
                    limit = value;
                    return query;
                },
                maybeSingle() {
                    single = true;
                    return query;
                },
                delete() {
                    action = "delete";
                    return query;
                },
                update(value: Row) {
                    action = "update";
                    patch = value;
                    return query;
                },
                insert(value: Row) {
                    action = "insert";
                    patch = value;
                    return query;
                },
                then(
                    resolve: (value: unknown) => unknown,
                    reject?: (error: unknown) => unknown,
                ) {
                    const error = failures.get(`${table}:${action}`);
                    if (error)
                        return Promise.resolve({ data: null, error }).then(
                            resolve,
                            reject,
                        );
                    const found = rows
                        .filter((r) => filters.every((f) => f(r)))
                        .slice(0, limit);
                    if (action === "delete") {
                        for (const row of found)
                            rows.splice(rows.indexOf(row), 1);
                        options.onDelete?.(table);
                    }
                    if (action === "update")
                        for (const row of found) Object.assign(row, patch);
                    if (action === "insert") rows.push({ ...patch });
                    if (action === "insert" || action === "update") {
                        writes.push({ table, row: patch });
                        options.onInsert?.(table, patch);
                    }
                    return Promise.resolve({
                        data: single ? (found[0] ?? null) : found,
                        error: null,
                    }).then(resolve, reject);
                },
            };
            return query;
        },
        async rpc(name: string, args: Row) {
            if (failures.has(name))
                return { data: null, error: failures.get(name) };
            if (name === "complete_google_drive_oauth") {
                const index = states.findIndex(
                    (r) =>
                        r.state_hash === args.p_state_hash &&
                        String(r.expires_at) > new Date().toISOString(),
                );
                if (index < 0) return { data: false, error: null };
                const state = states.splice(index, 1)[0];
                const row = {
                    ...(args.p_tokens as Row),
                    user_id: state.user_id,
                };
                const prior = tokens.findIndex(
                    (r) => r.user_id === row.user_id,
                );
                if (prior >= 0) tokens.splice(prior, 1);
                tokens.push(row);
                writes.push({ table: "user_google_drive_tokens", row });
                return { data: true, error: null };
            }
            if (name === "disconnect_google_drive") {
                for (let i = states.length - 1; i >= 0; i--)
                    if (states[i].user_id === args.p_user_id)
                        states.splice(i, 1);
                const index = tokens.findIndex(
                    (r) => r.user_id === args.p_user_id,
                );
                const row = index >= 0 ? tokens.splice(index, 1)[0] : null;
                return { data: row, error: null };
            }
            throw new Error(`Unexpected RPC ${name}`);
        },
    } as unknown as Db;
    return { db, tokens, states, writes, failures };
}
