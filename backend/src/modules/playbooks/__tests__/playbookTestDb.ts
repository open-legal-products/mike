// An in-memory stand-in for the Supabase client that executes filters as
// well as recording writes, shared by the playbook module tests.
import type { Db } from "../../../lib/supabase";

export const ORG = "11111111-1111-4111-8111-111111111111";
export const OTHER = "22222222-2222-4222-8222-222222222222";
export type Row = Record<string, unknown>;

/** Execute filters as well as record writes, to exercise tenant isolation. */
export function database(
  rows: Row[],
  members: Row[] = [],
  profiles: Row[] = [],
  overrides: Row[] = [],
) {
  // A fixture's shared_with becomes viewer grants, as the 20261017_04
  // migration moved them.
  const shares = rows.flatMap((row) =>
    ((row.shared_with as string[] | undefined) ?? []).map((email) => ({
      id: `share-${row.id}-${email}`,
      playbook_id: row.id,
      shared_with_email: email,
      role: "viewer",
    })),
  );
  rows.forEach((row) => delete row.shared_with);
  const tables: Record<string, Row[]> = {
    playbooks: rows,
    playbook_shares: shares,
    playbook_org_access_overrides: overrides,
    org_members: members,
    user_profiles: profiles,
    organizations: [
      { id: ORG, kind: "team" },
      { id: OTHER, kind: "team" },
    ],
    playbook_runs: [],
  };
  const writes: { table: string; op: string; payload: Row }[] = [];
  const from = (table: string) => {
    const predicates: ((row: Row) => boolean)[] = [];
    let op = "select";
    let payload: Row = {};
    let upserts: Row[] = [];
    let conflict: string[] = [];
    const settle = () => {
      let result = (tables[table] ?? []).filter((row) =>
        predicates.every((test) => test(row)),
      );
      if (op !== "select") {
        writes.push({ table, op, payload });
        if (op === "insert") {
          (tables[table] ??= []).push(payload);
          result = [payload];
        }
        if (op === "update")
          result.forEach((row) => Object.assign(row, payload));
        if (op === "delete")
          tables[table] = (tables[table] ?? []).filter(
            (row) => !result.includes(row),
          );
        if (op === "upsert") {
          for (const value of upserts) {
            const existing = (tables[table] ??= []).find((row) =>
              conflict.every((key) => row[key] === value[key]),
            );
            if (existing) Object.assign(existing, value);
            else tables[table].push({ id: `${table}-${tables[table].length}`, ...value });
          }
          result = upserts;
        }
      }
      return { data: result, error: null };
    };
    const query = {
      select: () => query,
      eq: (key: string, value: unknown) => {
        predicates.push((row) => row[key] === value);
        return query;
      },
      is: (key: string, value: unknown) => {
        if (!key.includes("."))
          predicates.push((row) => (row[key] ?? null) === value);
        return query;
      },
      in: (key: string, values: unknown[]) => {
        predicates.push((row) => values.includes(row[key]));
        return query;
      },
      lt: (key: string, value: unknown) => {
        predicates.push((row) => String(row[key]) < String(value));
        return query;
      },
      contains: (key: string, values: unknown[]) => {
        predicates.push((row) =>
          values.every((value) => (row[key] as unknown[]).includes(value)),
        );
        return query;
      },
      order: () => query,
      limit: () => query,
      insert: (value: Row) => {
        op = "insert";
        payload = value;
        return query;
      },
      update: (value: Row) => {
        op = "update";
        payload = value;
        return query;
      },
      delete: () => {
        op = "delete";
        return query;
      },
      upsert: (values: Row[], options: { onConflict: string }) => {
        op = "upsert";
        upserts = values;
        payload = { rows: values.length };
        conflict = options.onConflict.split(",");
        return query;
      },
      single: async () => ({
        data: settle().data[0] ?? null,
        error: null,
      }),
      maybeSingle: async () => ({
        data: settle().data[0] ?? null,
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve(settle()).then(resolve),
    };
    return query;
  };
  return { db: { from } as unknown as Db, writes, tables };
}
