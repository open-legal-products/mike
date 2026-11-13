import { describe, expect, it } from "vitest";
import { createKeyedLock } from "../tools/documentLocks";

/** Whether `promise` has settled once pending callbacks have run. */
async function settled(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return done;
}

describe("acquireUnlessAborted", () => {
  it("acquires the lock like acquire when nothing aborts", async () => {
    const locks = createKeyedLock();
    const controller = new AbortController();
    const release = await locks.acquireUnlessAborted("d1", controller.signal);
    expect(release).toBeTypeOf("function");
    const next = locks.acquire("d1");
    expect(await settled(next)).toBe(false);
    release!();
    expect(await settled(next)).toBe(true);
  });

  it("stops waiting on abort and keeps the order of the calls queued behind", async () => {
    const locks = createKeyedLock();
    const releaseFirst = await locks.acquire("d1");
    const controller = new AbortController();
    const waiting = locks.acquireUnlessAborted("d1", controller.signal);
    const behind = locks.acquire("d1");

    controller.abort();
    expect(await waiting).toBeNull();
    // The holder still has the document: the call behind keeps waiting.
    expect(await settled(behind)).toBe(false);

    releaseFirst();
    expect(await settled(behind)).toBe(true);
  });

  it("does not take the lock for a signal that has already aborted", async () => {
    const locks = createKeyedLock();
    const controller = new AbortController();
    controller.abort();
    expect(await locks.acquireUnlessAborted("d1", controller.signal)).toBeNull();
    expect(await settled(locks.acquire("d1"))).toBe(true);
  });
});

describe("runUnlessAborted", () => {
  it("skips the work and resolves to null when the wait is aborted", async () => {
    const locks = createKeyedLock();
    const releaseFirst = await locks.acquire("d1");
    const controller = new AbortController();
    let ran = false;
    const pending = locks.runUnlessAborted("d1", controller.signal, async () => {
      ran = true;
      return "edited";
    });

    controller.abort();
    expect(await pending).toBeNull();
    releaseFirst();
    expect(await settled(locks.acquire("d1"))).toBe(true);
    expect(ran).toBe(false);
  });

  it("runs the work and releases the lock when nothing aborts", async () => {
    const locks = createKeyedLock();
    expect(await locks.runUnlessAborted("d1", undefined, async () => "edited")).toBe("edited");
    expect(await settled(locks.acquire("d1"))).toBe(true);
  });
});
