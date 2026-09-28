import { randomUUID } from "node:crypto";
import type { Db } from "../../supabase";
type Row = Record<string, unknown>;
/** Query fake for service tests; transaction guarantees are tested in Postgres. */
export function workspaceDb() {
  const tables: Record<string, Row[]> = {
    user_google_workspace_tokens: [],
    google_workspace_oauth_states: [],
    google_workspace_actions: [],
  };
  const failures = new Map<string, unknown>();
  const db = {
    from(table: string) {
      const rows = tables[table];
      let operation = "select";
      let patch: Row = {};
      let single = false;
      let limit = Infinity;
      const filters: ((r: Row) => boolean)[] = [];
      const query = {
        select() {
          return query;
        },
        eq(k: string, v: unknown) {
          filters.push((r) => r[k] === v);
          return query;
        },
        neq(k: string, v: unknown) {
          filters.push((r) => r[k] !== v);
          return query;
        },
        gt(k: string, v: string) {
          filters.push((r) => String(r[k]) > v);
          return query;
        },
        lt(k: string, v: string) {
          filters.push((r) => String(r[k]) < v);
          return query;
        },
        limit(n: number) {
          limit = n;
          return query;
        },
        order() {
          return query;
        },
        maybeSingle() {
          single = true;
          return query;
        },
        single() {
          single = true;
          return query;
        },
        insert(v: Row) {
          operation = "insert";
          patch = v;
          return query;
        },
        update(v: Row) {
          operation = "update";
          patch = v;
          return query;
        },
        delete() {
          operation = "delete";
          return query;
        },
        then(
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) {
          if (failures.has(`${table}:${operation}`))
            return Promise.resolve({
              data: null,
              error: failures.get(`${table}:${operation}`),
            }).then(resolve, reject);
          let found = rows
            .filter((r) => filters.every((f) => f(r)))
            .slice(0, limit);
          if (operation === "insert") {
            const row = {
              id: randomUUID(),
              created_at: new Date().toISOString(),
              status: "pending",
              ...patch,
            };
            rows.push(row);
            found = [row];
          }
          if (operation === "update")
            found.forEach((r) => Object.assign(r, patch));
          if (operation === "delete")
            found.forEach((r) => rows.splice(rows.indexOf(r), 1));
          return Promise.resolve({
            data: single ? (found[0] ?? null) : found,
            error: null,
          }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Row) {
      if (failures.has(name)) return { data: null, error: failures.get(name) };
      const grants = tables.user_google_workspace_tokens,
        states = tables.google_workspace_oauth_states,
        actions = tables.google_workspace_actions;
      if (name === "complete_google_workspace_oauth") {
        const state = states.find(
          (s) =>
            s.state_hash === args.p_state_hash &&
            s.provider === args.p_provider &&
            String(s.expires_at) > new Date().toISOString(),
        );
        if (!state) return { data: false, error: null };
        states.splice(states.indexOf(state), 1);
        const prior = grants.find(
          (g) => g.user_id === state.user_id && g.provider === state.provider,
        );
        if (prior) grants.splice(grants.indexOf(prior), 1);
        grants.push({
          ...(args.p_tokens as Row),
          user_id: state.user_id,
          provider: state.provider,
          write_enabled: state.write_enabled,
          grant_id: randomUUID(),
        });
        actions
          .filter(
            (a) =>
              a.user_id === state.user_id &&
              a.provider === state.provider &&
              a.status === "pending",
          )
          .forEach((a) => (a.status = "rejected"));
        return { data: true, error: null };
      }
      if (name === "disconnect_google_workspace") {
        for (const rows of [grants, states])
          for (const r of [...rows])
            if (r.user_id === args.p_user_id && r.provider === args.p_provider)
              rows.splice(rows.indexOf(r), 1);
        actions
          .filter(
            (a) =>
              a.user_id === args.p_user_id &&
              a.provider === args.p_provider &&
              a.status === "pending",
          )
          .forEach((a) => (a.status = "rejected"));
        return { data: null, error: null };
      }
      if (name === "claim_google_workspace_action") {
        const a = actions.find(
          (a) =>
            a.id === args.p_action_id &&
            a.user_id === args.p_user_id &&
            a.status === "pending" &&
            String(a.expires_at) > new Date().toISOString() &&
            grants.some(
              (g) =>
                g.user_id === a.user_id &&
                g.provider === a.provider &&
                g.grant_id === a.grant_id &&
                g.write_enabled === true,
            ),
        );
        if (!a) return { data: null, error: null };
        a.status = "executing";
        return { data: { ...a }, error: null };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  } as unknown as Db;
  return { db, tables, failures };
}
