import type { Db } from "../../supabase";
import { randomUUID } from "node:crypto";

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
    // Feature flags (lib/featureFlags.ts): empty means every code default applies.
    const flags: Record<string, Row[]> = {
        feature_flag_defaults: [],
        user_feature_flags: [],
    };
    const writes: { table: string; row: Row }[] = [];
    const failures = new Map<string, unknown>();
    const db = {
        from(table: string) {
            const rows =
                table === "user_google_drive_tokens"
                    ? tokens
                    : (flags[table] ?? states);
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
                // Only the workspace filter (`org_id` eq/is) is used.
                filter(key: string, op: string, value: unknown) {
                    filters.push((r) =>
                        op === "is"
                            ? (r[key] ?? null) === value
                            : r[key] === value,
                    );
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
                const sameWorkspace = (r: Row) =>
                    r.user_id === state.user_id &&
                    (r.org_id ?? null) === (state.org_id ?? null);
                const previous = tokens.find(sameWorkspace);
                const row = {
                    enabled: previous?.enabled ?? true,
                    disabled_tools: previous?.disabled_tools ?? [],
                    require_write_approval: previous?.require_write_approval ?? false,
                    read_only: previous?.read_only ?? false,
                    grant_id: randomUUID(),
                    ...(args.p_tokens as Row),
                    user_id: state.user_id,
                    org_id: state.org_id ?? null,
                };
                const prior = tokens.findIndex(sameWorkspace);
                if (prior >= 0) tokens.splice(prior, 1);
                tokens.push(row);
                writes.push({ table: "user_google_drive_tokens", row });
                return { data: true, error: null };
            }
            if (name === "disconnect_google_drive") {
                const inWorkspace = (r: Row) =>
                    r.user_id === args.p_user_id &&
                    (r.org_id ?? null) === (args.p_org_id ?? null);
                for (let i = states.length - 1; i >= 0; i--)
                    if (inWorkspace(states[i])) states.splice(i, 1);
                const index = tokens.findIndex(inWorkspace);
                const row = index >= 0 ? tokens.splice(index, 1)[0] : null;
                return { data: row, error: null };
            }
            throw new Error(`Unexpected RPC ${name}`);
        },
    } as unknown as Db;
    return { db, tokens, states, flags, writes, failures };
}
