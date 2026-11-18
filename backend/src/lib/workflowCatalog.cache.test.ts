import { expect, it, vi } from "vitest";
import { activeAssistantPrompts } from "./workflowCatalog";
import type { Db } from "./supabase";

it.each([false, true])("review regression: coalesces catalog misses and retries rejected loads (failure=%s)", async fail => {
  let finish!: () => void;
  let failure = fail;
  let bodies = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const db = { from: () => {
    let columns = "", continuation = false;
    const query = {
      select(value: string) { columns = value; return query; },
      eq: () => query, in: () => query, order: () => query, limit: () => query,
      gt() { continuation = true; return query; },
      then(resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) {
        return (async () => {
          const body = columns.includes("prompt_md");
          if (body) { bodies++; await gate; }
          return { data: continuation ? [] : [{ id: "v1", workflow_key: "one", title: "One", prompt_md: "Instructions" }],
            error: body && failure ? new Error("temporary failure") : null };
        })().then(resolve, reject);
      },
    };
    return query;
  } } as unknown as Db;
  const both = Promise.allSettled([activeAssistantPrompts(db), activeAssistantPrompts(db)]);
  await vi.waitFor(() => expect(bodies).toBeGreaterThan(0));
  finish();
  const results = await both;
  expect(bodies).toBe(1);
  expect(results.map(result => result.status)).toEqual(fail ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"]);
  failure = false;
  expect(await activeAssistantPrompts(db)).toEqual([{ id: "v1", workflow_key: "one", title: "One", prompt_md: "Instructions" }]);
  expect(bodies).toBe(fail ? 2 : 1);
});
