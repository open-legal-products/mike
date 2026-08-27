import { describe, expect, it, vi } from "vitest";

import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("bounds active work and preserves result order", async () => {
    let active = 0;
    let maxActive = 0;
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const result = mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (value < 2) await blocked;
      active -= 1;
      return value * 2;
    });

    await vi.waitFor(() => expect(active).toBe(2));
    release();

    await expect(result).resolves.toEqual([0, 2, 4, 6]);
    expect(maxActive).toBe(2);
  });

  it("handles empty input and clamps invalid concurrency", async () => {
    await expect(
      mapWithConcurrency([], 0, async (value: number) => value),
    ).resolves.toEqual([]);
    await expect(
      mapWithConcurrency([1, 2], 0, async (value) => value),
    ).resolves.toEqual([1, 2]);
  });
});
