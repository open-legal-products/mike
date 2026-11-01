import { randomUUID } from "node:crypto";
import type { Db } from "../../lib/supabase";

type Row = Record<string, unknown>;

export type TableDbCall = {
  table: string;
  op: "select" | "update" | "delete" | "insert" | "upsert";
  /** Length of every `.in()` list the query carried. */
  inSizes: number[];
  /** Rows the response carried (after the max_rows cap). */
  returned: number;
};

/**
 * An in-memory PostgREST stand-in that enforces the two limits production
 * hides: a response is silently capped at `maxRows` (PostgREST `max_rows`),
 * and an `.in()` list longer than `maxInList` fails the way an over-long
 * request URL does at the gateway (a 414 with `data: null`). Tests built on
 * it observe truncation and dropped batches as wrong results, the way users
 * would, and can count round trips through `calls`.
 */
export function tableDb(
  tables: Record<string, Row[]>,
  { maxRows = 1000, maxInList = 50 }: { maxRows?: number; maxInList?: number } = {},
) {
  const calls: TableDbCall[] = [];
  const from = (table: string) => {
    tables[table] ??= [];
    const preds: Array<(row: Row) => boolean> = [];
    const orders: Array<[string, boolean]> = [];
    let limit = Infinity;
    let offset = 0;
    let op: TableDbCall["op"] = "select";
    let payload: unknown;
    let tooLong = false;
    const inSizes: number[] = [];
    const settle = (one: boolean) => {
      const rows = tables[table];
      const call: TableDbCall = { table, op, inSizes, returned: 0 };
      calls.push(call);
      if (tooLong) {
        return Promise.resolve({ data: null, error: { message: "Request-URI Too Large", code: "414" } });
      }
      if (op === "insert" || op === "upsert") {
        const inserted = ((Array.isArray(payload) ? payload : [payload]) as Row[])
          .map((row) => ({ id: randomUUID(), ...row }));
        for (const row of inserted) {
          const existing = op === "upsert" ? rows.find((r) => r.id === row.id) : undefined;
          if (existing) Object.assign(existing, row);
          else rows.push({ ...row });
        }
        return Promise.resolve({ data: inserted, error: null });
      }
      let matched = rows.filter((row) => preds.every((pred) => pred(row)));
      if (op === "delete") {
        tables[table] = rows.filter((row) => !matched.includes(row));
        return Promise.resolve({ data: null, error: null });
      }
      if (op === "update") {
        for (const row of matched) Object.assign(row, payload);
        const copies = matched.map((row) => ({ ...row }));
        return Promise.resolve({ data: one ? (copies[0] ?? null) : copies, error: null });
      }
      matched = [...matched].sort((a, b) => {
        for (const [column, ascending] of orders) {
          const left = a[column] as string | number;
          const right = b[column] as string | number;
          if (left === right) continue;
          return (left < right ? -1 : 1) * (ascending ? 1 : -1);
        }
        return 0;
      });
      // Copies, like rows decoded from a real response.
      const data = matched.slice(offset, offset + Math.min(limit, maxRows)).map((row) => ({ ...row }));
      call.returned = data.length;
      return Promise.resolve({ data: one ? (data[0] ?? null) : data, error: null });
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (c: string, v: unknown) => (preds.push((r) => r[c] === v), builder),
      neq: (c: string, v: unknown) => (preds.push((r) => r[c] !== v), builder),
      gt: (c: string, v: never) => (preds.push((r) => (r[c] as never) > v), builder),
      lt: (c: string, v: never) => (preds.push((r) => (r[c] as never) < v), builder),
      is: (c: string, v: unknown) => (preds.push((r) => (r[c] ?? null) === v), builder),
      not: (c: string, o: string, v: unknown) =>
        (preds.push((r) => !(o === "is" ? (r[c] ?? null) === v : r[c] === v)), builder),
      in: (c: string, values: unknown[]) => {
        inSizes.push(values.length);
        if (values.length > maxInList) tooLong = true;
        preds.push((r) => values.includes(r[c]));
        return builder;
      },
      order: (c: string, o?: { ascending?: boolean }) => (orders.push([c, o?.ascending !== false]), builder),
      limit: (n: number) => ((limit = n), builder),
      range: (start: number, end: number) => ((offset = start), (limit = end - start + 1), builder),
      single: () => settle(true),
      maybeSingle: () => settle(true),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        settle(false).then(resolve, reject),
    };
    for (const name of ["update", "delete", "insert", "upsert"] as const) {
      builder[name] = (value?: unknown) => ((op = name), (payload = value), builder);
    }
    return builder;
  };
  return { db: { from } as unknown as Db, calls, tables };
}
