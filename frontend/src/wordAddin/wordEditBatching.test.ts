import { afterEach, describe, expect, it, vi } from "vitest";
import { createSerialBatcher } from "../../../word-addin/src/taskpane/lib/serialBatcher";
import { bookmarkNameForEdit, getWordEditAnchor, getWordEditAnchors, listAppliedWordEditIds, persistWordEditState, removeWordEditAnchors } from "../../../word-addin/src/taskpane/lib/wordEditAnchors";

function settingsFixture() {
  const values = new Map<string, unknown>();
  const get = vi.fn((key: string) => values.get(key));
  const save = vi.fn((cb: (result: { status: string; error?: { message: string } }) => void) => cb({ status: "succeeded" }));
  vi.stubGlobal("Office", { AsyncResultStatus: { Succeeded: "succeeded" }, context: { document: { settings: { get, set: (key: string, value: unknown) => values.set(key, value), remove: (key: string) => values.delete(key), saveAsync: save } } } });
  return { values, get, save };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("Word edit persistence batch", () => {
  it("saves N anchors and replay markers at one durable boundary", async () => {
    for (const n of [50, 100, 200]) {
      const { get, save } = settingsFixture();
      const ids = Array.from({ length: n }, (_, i) => `edit-${i}`);
      await persistWordEditState(ids.map(stableEditId => ({ stableEditId, bookmarkName: bookmarkNameForEdit(stableEditId) })), ids);
      expect(get).toHaveBeenCalledTimes(2);
      expect(save).toHaveBeenCalledTimes(1);
      expect(Object.keys(getWordEditAnchors())).toEqual(ids);
      expect([...listAppliedWordEditIds()]).toEqual(ids);
      await removeWordEditAnchors(ids);
      expect(save).toHaveBeenCalledTimes(2);
      expect(getWordEditAnchors()).toEqual({});
      expect([...listAppliedWordEditIds()]).toEqual(ids); // Accept/reject must not permit replay.
    }
  });
  it("validates all anchor names before mutating settings and preserves a failed save for retry", async () => {
    const { values, save } = settingsFixture();
    await expect(persistWordEditState([{ stableEditId: "bad", bookmarkName: "wrong" }], ["bad"])).rejects.toThrow("does not match");
    expect(values.size).toBe(0);
    save.mockImplementationOnce(cb => cb({ status: "failed", error: { message: "save failed" } }));
    const anchors = [{ stableEditId: "good", bookmarkName: bookmarkNameForEdit("good") }];
    await expect(persistWordEditState(anchors, ["good"])).rejects.toThrow("save failed");
    await persistWordEditState(anchors, ["good"]);
    expect(getWordEditAnchors().good?.bookmarkName).toBe(anchors[0].bookmarkName);
    expect([...listAppliedWordEditIds()]).toEqual(["good"]);
  });
});

describe("Word edit anchor lookup", () => {
  it("validates only the requested anchor, not the whole registry", () => {
    const { values } = settingsFixture();
    const entries = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`edit-${i}`, { bookmarkName: bookmarkNameForEdit(`edit-${i}`), createdAt: "2026-01-01" }]));
    const touched = new Set<PropertyKey>();
    const anchors = new Proxy(entries, { get: (target, key) => { touched.add(key); return Reflect.get(target, key); } });
    // The fixture's get() returns the stored object itself, as Office does for its working copy.
    values.set("mike.wordEditAnchors.v1", { version: 1, anchors });
    expect(getWordEditAnchor("edit-7")).toEqual(entries["edit-7"]);
    expect(getWordEditAnchor("missing")).toBeNull();
    expect([...touched].filter(key => typeof key === "string" && key.startsWith("edit-"))).toEqual(["edit-7"]);
  });
});

describe("Word apply request batching", () => {
  it("coalesces concurrently ready cards and preserves each caller's order", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async (items: number[]) => items.map(i => i * 2));
    const request = createSerialBatcher(run);
    const replies = Array.from({ length: 50 }, (_, i) => request(i));
    await vi.runAllTimersAsync();
    expect(await Promise.all(replies)).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("keeps arrivals during an in-flight operation in the next batch and recovers from failures", async () => {
    vi.useFakeTimers();
    let finish!: (values: number[]) => void;
    const run = vi.fn<(items: number[]) => Promise<number[]>>()
      .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error("host failed"))
      .mockImplementation(async items => items);
    const request = createSerialBatcher(run);
    const first = request(1);
    await vi.advanceTimersByTimeAsync(0);
    const second = request(2);
    const rejected = expect(second).rejects.toThrow("host failed");
    finish([1]);
    await expect(first).resolves.toBe(1);
    await rejected;
    const third = request(3);
    await vi.runAllTimersAsync();
    await expect(third).resolves.toBe(3);
    expect(run.mock.calls).toEqual([[[1]], [[2]], [[3]]]);
  });
});
