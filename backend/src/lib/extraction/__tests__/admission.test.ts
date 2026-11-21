import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtractionBusyError, runIsolatedExtraction, withExtractionSlot, withExtractionRequest, withBackgroundExtraction } from "../isolated";
import { extractionTimeoutMs } from "../limits";

vi.mock("../ops", () => ({ EXTRACTION_OPS: { spreadsheet: async () => "text" } }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function occupy() {
  let release!: () => void;
  const held = withExtractionSlot({}, () => new Promise<void>((resolve) => { release = resolve; }));
  return { held, release };
}

describe("parser admission", () => {
  it("defers all excess durable jobs before their download callbacks run", async () => {
    const { held, release } = occupy();
    const downloadAndParse = vi.fn(async () => "text");
    try {
      const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => withExtractionSlot({ waitMs: 0 }, downloadAndParse)));
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
        if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ExtractionBusyError);
      }
      expect(downloadAndParse).not.toHaveBeenCalled();
    } finally { release(); await held; }
    await expect(withExtractionSlot({ waitMs: 0 }, downloadAndParse)).resolves.toBe("text");
  });

  it("runs short background work without a deferral when the parser frees up", async () => {
    vi.useFakeTimers();
    const { held, release } = occupy();
    const work = vi.fn(async () => "text");
    const waiting = withExtractionSlot({ waitMs: 60_000 }, work);
    await vi.advanceTimersByTimeAsync(100);
    expect(work).not.toHaveBeenCalled();
    release(); await held;
    await expect(waiting).resolves.toBe("text");
    expect(work).toHaveBeenCalledOnce();
  });

  it("prioritizes waiting interactive parses over a background parse", async () => {
    const { held, release } = occupy();
    const order: string[] = [];
    const background = withBackgroundExtraction({}, async (extract) => {
      await extract("spreadsheet", new ArrayBuffer(1));
      order.push("background");
    });
    const interactive = withExtractionRequest(async (extract) => {
      await extract("spreadsheet", new ArrayBuffer(1));
      order.push("interactive");
    });
    release(); await held;
    await Promise.all([background, interactive]);
    expect(order).toEqual(["interactive", "background"]);
  });

  it("allows interactive parsing during background I/O without crowding its queue", async () => {
    let release!: () => void;
    const held = withBackgroundExtraction({}, () => new Promise<void>((resolve) => { release = resolve; }));
    const work = vi.fn(async () => "indexed");
    const jobs = Array.from({ length: 12 }, () => withBackgroundExtraction({}, work));
    try {
      await expect(runIsolatedExtraction("spreadsheet", async () => new ArrayBuffer(1))).resolves.toBe("text");
      expect(work).not.toHaveBeenCalled();
    } finally { release(); await held; }
    await expect(Promise.all(jobs)).resolves.toEqual(Array(12).fill("indexed"));
  });

  it("bounds combined background admission and parser waiting to one lease budget", async () => {
    vi.useFakeTimers();
    let releaseBackground!: () => void;
    const background = withBackgroundExtraction({}, () => new Promise<void>((resolve) => { releaseBackground = resolve; }));
    const { held, release } = occupy();
    const work = vi.fn(async (extract) => extract("spreadsheet", new ArrayBuffer(1)));
    const waiting = withBackgroundExtraction({ waitMs: 60_000 }, work);
    const rejected = expect(waiting).rejects.toBeInstanceOf(ExtractionBusyError);
    try {
      await vi.advanceTimersByTimeAsync(40_000);
      releaseBackground(); await background;
      expect(work).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20_000);
      await rejected;
    } finally { releaseBackground(); release(); await Promise.all([background, held]); }
    await expect(withBackgroundExtraction({ waitMs: 0 }, work)).resolves.toBe("text");
  });

  it("waits for interactive capacity without timing out behind a valid long parse", async () => {
    vi.useFakeTimers();
    const releases: Array<() => void> = [];
    const held = Array.from({ length: 3 }, () => withExtractionRequest(() => new Promise<void>((resolve) => { releases.push(resolve); })));
    const download = vi.fn(async () => new ArrayBuffer(1));
    const waiting = runIsolatedExtraction("spreadsheet", download);
    try {
      await vi.advanceTimersByTimeAsync(180_000);
      expect(download).not.toHaveBeenCalled();
    } finally { releases.forEach((release) => release()); await Promise.all(held); }
    await expect(waiting).resolves.toBe("text");
  });

  it("overlaps three downloads with an occupied parser without starting a fourth", async () => {
    const { held, release } = occupy();
    const download = vi.fn(async () => new ArrayBuffer(1));
    const requests = Array.from({ length: 4 }, () => runIsolatedExtraction("spreadsheet", download));
    try {
      await Promise.resolve();
      expect(download).toHaveBeenCalledTimes(3);
    } finally { release(); await held; }
    await expect(Promise.all(requests)).resolves.toEqual(["text", "text", "text", "text"]);
    expect(download).toHaveBeenCalledTimes(4);
  });

  it("releases interactive capacity after failed downloads", async () => {
    await Promise.all(Array.from({ length: 3 }, () => expect(
      runIsolatedExtraction("spreadsheet", async () => null),
    ).rejects.toThrow("document_text_source_unavailable")));
    await expect(runIsolatedExtraction("spreadsheet", async () => new ArrayBuffer(1))).resolves.toBe("text");
  });

  it("bounds queued requests and serves them in FIFO order", async () => {
    const { held, release } = occupy();
    const order: number[] = [];
    const waiting = Array.from({ length: 8 }, (_, index) => withExtractionSlot({}, async () => { order.push(index); }));
    try {
      await expect(withExtractionSlot({}, async () => {})).rejects.toBeInstanceOf(ExtractionBusyError);
    } finally { release(); await held; await Promise.all(waiting); }
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("releases a slot after a failure and clamps execution below the stale lease", async () => {
    await expect(withExtractionSlot({}, async () => { throw new Error("broken source"); })).rejects.toThrow("broken source");
    await expect(withExtractionSlot({ waitMs: 0 }, async () => "next")).resolves.toBe("next");
    vi.stubEnv("EXTRACTION_TIMEOUT_MS", "3600000");
    expect(extractionTimeoutMs()).toBe(300_000);
  });
});
