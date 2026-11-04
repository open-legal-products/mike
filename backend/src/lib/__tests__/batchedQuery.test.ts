import { describe, expect, it } from "vitest";
import {
  BatchedQueryError,
  mutateInBatches,
  selectAllByKey,
  selectAllPages,
  selectInBatches,
} from "../batchedQuery";
import { tableDb } from "../../__tests__/helpers/tableDb";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);

describe("batchedQuery", () => {
  it("sends distinct ids in bounded batches and concatenates the rows", async () => {
    const sizes: number[] = [];
    const rows = await selectInBatches("lookup", [...ids(120), "id-0", null], async (batch) => {
      sizes.push(batch.length);
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(sizes).toEqual([50, 50, 20]);
    expect(rows).toHaveLength(120);
  });

  it("treats a failed batch as a failure, not as no rows", async () => {
    let calls = 0;
    await expect(
      mutateInBatches("delete", ids(60), async () => ({ error: calls++ ? { message: "414" } : null })),
    ).rejects.toBeInstanceOf(BatchedQueryError);
    await expect(
      selectInBatches("lookup", ids(1), async () => ({ data: null, error: { message: "boom" } })),
    ).rejects.toThrow("lookup failed");
  });

  it("reads to an empty page, so a gateway capped below the page size cannot truncate", async () => {
    // A self-hosted PostgREST with max_rows = 500 answers every 1000-row
    // request with 500 rows; a loop that stops at the first short page
    // would return only the first 500.
    const table = ids(2500).map((id, i) => ({ id, i }));
    const cursors: Array<number | null> = [];
    const rows = await selectAllPages<{ id: string; i: number }>("page", async (after, limit) => {
      cursors.push(after?.i ?? null);
      const start = after ? after.i + 1 : 0;
      return { data: table.slice(start, start + Math.min(limit, 500)), error: null };
    });
    expect(rows).toHaveLength(2500);
    expect(cursors).toEqual([null, 499, 999, 1499, 1999, 2499]);
  });

  it("keyset-pages a filtered builder and stops when a page does not advance", async () => {
    const fake = tableDb({ items: ids(1200).map((id) => ({ id, kind: "a" })) }, { maxRows: 500 });
    const rows = await selectAllByKey<{ id: string }>("items", () =>
      fake.db.from("items").select("id").eq("kind", "a"),
    );
    expect(rows).toHaveLength(1200);
    // A builder that ignores the cursor returns the same page again: that is
    // the end, not more rows.
    const stuck = await selectAllByKey<{ id: string }>("stuck", () => {
      const page = { data: [{ id: "x" }], error: null };
      const builder = { order: () => builder, limit: () => builder, gt: () => builder,
        then: (resolve: (value: typeof page) => unknown) => Promise.resolve(page).then(resolve) };
      return builder;
    });
    expect(stuck).toEqual([{ id: "x" }]);
  });
});
