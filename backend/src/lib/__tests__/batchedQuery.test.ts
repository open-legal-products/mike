import { describe, expect, it } from "vitest";
import {
  BatchedQueryError,
  mutateInBatches,
  selectAllPages,
  selectInBatches,
} from "../batchedQuery";

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

  it("pages by cursor until a short page so a row cap cannot truncate", async () => {
    const table = ids(2500).map((id, i) => ({ id, i }));
    const cursors: Array<number | null> = [];
    const rows = await selectAllPages<{ id: string; i: number }>("page", async (after, limit) => {
      cursors.push(after?.i ?? null);
      const start = after ? after.i + 1 : 0;
      return { data: table.slice(start, start + limit), error: null };
    });
    expect(rows).toHaveLength(2500);
    expect(cursors).toEqual([null, 999, 1999]);
  });
});
