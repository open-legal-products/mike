import { describe, expect, it, vi } from "vitest";
import { createPollFailureGate, pollFailureClass } from "./pollFailureGate";

function gate(
  now: { t: number },
  summaryIntervalMs = 60_000,
  repeatReportIntervalMs?: number,
) {
  const log = { warn: vi.fn(), log: vi.fn() };
  const g = createPollFailureGate({
    label: "[loop]",
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    summaryIntervalMs,
    repeatReportIntervalMs,
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
    const a = pollFailureClass(new TypeError("x is not a function"));
    expect(a).toMatch(/^TypeError#[0-9a-f]{8}$/);
    expect(pollFailureClass(new TypeError("x is not a function"))).toBe(a);
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

  it("reports one outage once while it walks several connectivity codes", () => {
    const { g } = gate({ t: 0 });
    // One Postgres/gateway restart: the backend is terminated, PostgREST
    // loses its pool, then the gateway refuses connections (supabase-js
    // network shape: code '' with the errno only in `details`).
    const restart = [
      // What the gateway answers while its upstream is gone: a non-2xx with no
      // PostgREST body, which supabase-js surfaces as an error with every
      // field blank (seen live as the first failure of a database restart).
      new Error("Dependency failure (non-Error value)", {
        cause: { code: "", details: null, hint: null, message: "" },
      }),
      coded("57P01"),
      coded("PGRST002"),
      {
        message: "TypeError: fetch failed",
        details: "TypeError: fetch failed\n\nCaused by: Error: connect ECONNREFUSED private.host:8000 (ECONNREFUSED)\n    at private (node:net:1)",
        hint: "",
        code: "",
      },
      coded("ECONNREFUSED"),
    ];
    expect(restart.map((error) => g.failure(error).report)).toEqual([
      true, false, false, false, false,
    ]);
  });

  it("treats a gateway answer with no PostgREST body as the same outage", () => {
    const { g } = gate({ t: 0 });
    const wrap = (cause: object) =>
      new Error("Dependency failure (non-Error value)", { cause });
    const outage = [
      // postgrest-js, given an empty 503 body: { message: "" }, no `code`.
      wrap({ message: "" }),
      // The same with the status attached by withResponseStatus.
      wrap({ message: "", status: 503 }),
      // The gateway's own HTML error page.
      wrap({ message: "<html><h1>502 Bad Gateway</h1></html>", status: 502 }),
      coded("ECONNREFUSED"),
    ];
    expect(outage.map((error) => g.failure(error).report)).toEqual([
      true, false, false, false,
    ]);
  });

  it("does not fold a coded error or a 4xx with no code into the outage", () => {
    const wrap = (cause: object) =>
      new Error("Dependency failure (non-Error value)", { cause });
    expect(pollFailureClass(wrap({ message: "denied", status: 403 }))).not.toBe(
      pollFailureClass(coded("ECONNREFUSED")),
    );
    expect(pollFailureClass(wrap({ code: "42501", message: "", status: 503 }))).toBe(
      "Error:42501",
    );
    // A blank Error that wraps a coded cause is classified by the cause.
    expect(pollFailureClass(new Error("", { cause: { code: "42P01", message: "x" } }))).toBe(
      "Error:42P01",
    );
  });

  it("still reports a connectivity failure that follows a schema failure", () => {
    const { g } = gate({ t: 0 });
    expect(g.failure(coded("PGRST202")).report).toBe(true);
    expect(g.failure(coded("ECONNREFUSED")).report).toBe(true);
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

  it("logs recovery once, resets the backoff, and reports a new class after it", () => {
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
    const next = g.failure(coded("ECONNREFUSED"));
    expect(next).toEqual({ report: true, delayMs: 1_000, consecutive: 1 });
  });

  it("does not re-report a class that flaps back within the repeat window (MIKE-BACKEND-M)", () => {
    const now = { t: 0 };
    const { g, log } = gate(now, 60_000, 15 * 60_000);
    expect(g.failure(coded("40P01")).report).toBe(true);
    // Fail once, succeed for a while, fail the same way again: 64 of these an
    // hour were 64 Sentry events saying the same thing.
    const reported: boolean[] = [];
    for (let flap = 0; flap < 64; flap++) {
      now.t += 10_000;
      g.success();
      now.t += 1_000;
      reported.push(g.failure(coded("40P01")).report);
    }
    expect(reported).not.toContain(true);
    expect(g.failing).toBe(true);
    // The flapping is still visible in the log, at the summary cadence.
    const flapLines = log.warn.mock.calls.filter(([line]) =>
      String(line).startsWith("[loop] failing again (Error:40P01)"),
    );
    expect(flapLines.length).toBeGreaterThanOrEqual(10);
    expect(flapLines.length).toBeLessThan(64);
    expect(String(flapLines[0][0])).toMatch(/not re-reported; next attempt in 1s$/);
    // Backoff still applies to the first retry after each flap.
    expect(g.ready()).toBe(false);
    // Another class is news even mid-flap.
    now.t += 1_000;
    g.success();
    expect(g.failure(coded("PGRST202")).report).toBe(true);
    // Once the window has passed, the original class is reported again.
    now.t += 15 * 60_000;
    g.success();
    expect(g.failure(coded("40P01")).report).toBe(true);
  });

  it("remembers the report time of every class, not only the last one", () => {
    const now = { t: 0 };
    const { g } = gate(now, 60_000, 15 * 60_000);
    expect(g.failure(coded("40P01")).report).toBe(true);
    now.t += 60_000;
    g.success();
    expect(g.failure(coded("ECONNREFUSED")).report).toBe(true);
    // A, then B, then A again inside the window: A is still a repeat.
    now.t += 60_000;
    g.success();
    expect(g.failure(coded("40P01")).report).toBe(false);
    // B's own window is measured from B's report (t = 60 s), not from A's.
    now.t = 60_000 + 14 * 60_000;
    g.success();
    expect(g.failure(coded("ECONNREFUSED")).report).toBe(false);
    now.t = 60_000 + 15 * 60_000;
    g.success();
    expect(g.failure(coded("ECONNREFUSED")).report).toBe(true);
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

  it("keys failures with a caller's classify instead of pollFailureClass", () => {
    const now = { t: 0 };
    const g = createPollFailureGate({
      label: "[loop]",
      baseDelayMs: 0,
      maxDelayMs: 0,
      classify: (error) => `status:${(error as { status?: number }).status}`,
      now: () => now.t,
      log: { warn: vi.fn(), log: vi.fn() },
    });
    // Same name, no code, different message: one class under the caller's key.
    expect(g.failure(Object.assign(new Error("a"), { status: 0 })).report).toBe(true);
    expect(g.failure(Object.assign(new Error("b"), { status: 0 })).report).toBe(false);
    expect(g.failure(Object.assign(new Error("a"), { status: 503 })).report).toBe(true);
  });

  it("re-reports a persisting class once per repeatWhilePersistingMs, and never without it", () => {
    const withRepeat = { t: 0 };
    const repeating = createPollFailureGate({
      label: "[loop]",
      baseDelayMs: 0,
      maxDelayMs: 0,
      repeatWhilePersistingMs: 15 * 60_000,
      now: () => withRepeat.t,
      log: { warn: vi.fn(), log: vi.fn() },
    });
    const without = { t: 0 };
    const { g: once } = gate(without);
    const reports = { repeating: 0, once: 0 };
    // One failure a second for an hour.
    for (let second = 0; second < 3_600; second++) {
      if (repeating.failure(coded("ECONNREFUSED")).report) reports.repeating += 1;
      if (once.failure(coded("ECONNREFUSED")).report) reports.once += 1;
      withRepeat.t += 1_000;
      without.t += 1_000;
    }
    expect(reports).toEqual({ repeating: 4, once: 1 });
  });
});
