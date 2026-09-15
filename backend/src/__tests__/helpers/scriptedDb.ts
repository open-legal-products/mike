import { expect } from "vitest";
import type { Db } from "../../lib/supabase";

export type Query = {
  table: string;
  op: string;
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
};
type Step = {
  table: string;
  op?: string;
  data?: unknown;
  error?: unknown;
};

/** Strict query script: an unexpected query or changed mutation order fails.
 * Filters are recorded separately so tests can assert scope and ownership.
 */
export function scriptedDb(steps: Step[]) {
  const calls: Query[] = [];
  let cursor = 0;
  const from = (table: string) => {
    const call: Query = { table, op: "select", filters: [] };
    const settle = () => {
      calls.push(call);
      const step = steps[cursor++];
      expect(step, `Unexpected ${call.op} on ${table}`).toBeDefined();
      expect({ table, op: call.op }).toEqual({
        table: step.table,
        op: step.op ?? "select",
      });
      return Promise.resolve({
        data: step.data ?? null,
        error: step.error ?? null,
      });
    };
    const builder: Record<string, unknown> = {
      select: () => builder,
      single: settle,
      maybeSingle: settle,
      then: (
        resolve: (value: unknown) => unknown,
        reject: (error: unknown) => unknown,
      ) => settle().then(resolve, reject),
    };
    for (const op of ["update", "insert", "delete"]) {
      builder[op] = (payload?: unknown) => {
        call.op = op;
        call.payload = payload;
        return builder;
      };
    }
    for (const filter of ["eq", "is", "in", "or", "order", "range", "limit"]) {
      builder[filter] = (...args: unknown[]) => {
        call.filters.push([filter, ...args]);
        return builder;
      };
    }
    return builder;
  };
  return {
    db: { from } as unknown as Db,
    calls,
    done: () =>
      expect(cursor, "Not all expected queries ran").toBe(steps.length),
  };
}
