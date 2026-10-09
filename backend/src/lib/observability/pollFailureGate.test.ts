import { describe, expect, it, vi } from "vitest";
import { createPollFailureGate, pollFailureClass } from "./pollFailureGate";

function gate(now: { t: number }, summaryIntervalMs = 60_000) {
  const log = { warn: vi.fn(), log: vi.fn() };
  const g = createPollFailureGate({
    label: "[loop]",
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    summaryIntervalMs,
    now: () => now.t,
    log,
  });
  return { g, log };
}

const coded = (code: string) =>
  new Error("Dependency failure", { cause: { code, message: "secret text" } });

describe("pollFailureClass", () => {
  it("keys by name and a code found on the cause chain, never by the message", () => {
    expect(pollFailureClass(coded("PGRST202"))).toBe("Error:PGRST202");
    expect(pollFailureClass(coded("PGRST202"))).not.toContain("secret");
  });

  it("keys code-less errors by a message hash, so different messages differ", () => {
    const a = pollFailureClass(new TypeError("fetch failed"));
    expect(a).toMatch(/^TypeError#[0-9a-f]{8}$/);
    expect(pollFailureClass(new TypeError("fetch failed"))).toBe(a);
    expect(pollFailureClass(new TypeError("other"))).not.toBe(a);
  });

  it("survives non-objects and cyclic causes", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(pollFailureClass(cyclic)).toMatch(/^Error#/);
    expect(pollFailureClass("boom")).toMatch(/^string#/);
    expect(pollFailureClass(undefined)).toMatch(/^undefined#/);
  });
});

describe("createPollFailureGate", () => {
  it("reports the first failure of a class only, backing off to the ceiling", () => {
    const now = { t: 0 };
    const { g } = gate(now);
    const verdicts = Array.from({ length: 8 }, () => {
      const v = g.failure(coded("PGRST202"));
      now.t += v.delayMs;
      return v;
    });
    expect(verdicts.map((v) => v.report)).toEqual([
      true, false, false, false, false, false, false, false,
    ]);
    expect(verdicts.map((v) => v.delayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
    ]);
    expect(g.failing).toBe(true);
  });

  it("reports again when the failure class changes", () => {
    const { g } = gate({ t: 0 });
    expect(g.failure(coded("PGRST202")).report).toBe(true);
    expect(g.failure(coded("PGRST202")).report).toBe(false);
    expect(g.failure(coded("ECONNREFUSED")).report).toBe(true);
    expect(g.failure(coded("ECONNREFUSED")).report).toBe(false);
  });

  it("logs a compact still-failing line at most once per summary interval", () => {
    const now = { t: 0 };
    const { g, log } = gate(now);
    g.failure(coded("PGRST202"));
    for (let i = 0; i < 30; i++) {
      now.t += 5_000; // 150 s of repeats
      g.failure(coded("PGRST202"));
    }
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^\[loop\] still failing \(Error:PGRST202\): 13 consecutive failures, 12 not re-reported/,
    );
  });

  it("logs recovery once, resets the backoff, and reports the next failure", () => {
    const now = { t: 0 };
    const { g, log } = gate(now);
    g.failure(coded("PGRST202"));
    g.failure(coded("PGRST202"));
    expect(g.ready()).toBe(false);
    g.success();
    g.success();
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledWith(
      "[loop] recovered after 2 consecutive failure(s)",
    );
    expect(g.ready()).toBe(true);
    expect(g.failing).toBe(false);
    const next = g.failure(coded("PGRST202"));
    expect(next).toEqual({ report: true, delayMs: 1_000, consecutive: 1 });
  });

  it("gates ticks until the backed-off retry time", () => {
    const now = { t: 0 };
    const { g } = gate(now);
    g.failure(coded("PGRST202"));
    const { delayMs } = g.failure(coded("PGRST202"));
    expect(delayMs).toBe(2_000);
    now.t += 1_999;
    expect(g.ready()).toBe(false);
    now.t += 1;
    expect(g.ready()).toBe(true);
  });
});
