import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  noteUpstreamReachable,
  resetUpstreamOutagesForTests,
  shouldReportUpstreamFailure,
  upstreamFailureClass,
} from "../upstreamOutage";

function authError(status: number): Error {
  return Object.assign(new Error("fetch failed"), {
    name: "AuthRetryableFetchError",
    __isAuthError: true,
    status,
  });
}

let clock = 0;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clock = 1_000_000;
  resetUpstreamOutagesForTests(() => clock);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  resetUpstreamOutagesForTests();
  vi.restoreAllMocks();
});

describe("upstreamFailureClass", () => {
  it("keys an auth-js error by the status it saw, through a wrapper", () => {
    const wrapped = new Error("session lookup could not reach GoTrue", { cause: authError(0) });
    expect(upstreamFailureClass(wrapped)).toBe("gotrue:0");
    expect(upstreamFailureClass(authError(503))).toBe("gotrue:503");
  });
});

describe("shouldReportUpstreamFailure", () => {
  it("reports the first failure of a class and counts the repeats into one line a minute", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(0);
    clock += 60_000;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("[upstream-unavailable] still failing (gotrue:0)");
    expect(String(warn.mock.calls[0]![0])).toContain("2 not re-reported");
  });

  it("files ONE event for a GoTrue that alternates success and failure for 10 minutes", () => {
    let reports = 0;
    // One request a second, every other one failing: 300 failures.
    for (let second = 0; second < 600; second++) {
      if (second % 2 === 0) {
        if (shouldReportUpstreamFailure(authError(503))) reports += 1;
      } else {
        noteUpstreamReachable();
      }
      clock += 1_000;
    }
    expect(reports).toBe(1);
  });

  it("re-reports a steady outage at 15 minutes, not before", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    clock += 15 * 60_000 - 1;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    clock += 1;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
  });

  it("treats a different class as news", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    expect(shouldReportUpstreamFailure(authError(503))).toBe(true);
    expect(shouldReportUpstreamFailure(authError(503))).toBe(false);
  });

  it("reports the next outage as news after a quiet period, not after a brief recovery", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    noteUpstreamReachable();
    clock += 60_000;
    // Back within the window: the same outage flapping.
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    noteUpstreamReachable();
    clock += 15 * 60_000;
    // Quiet for longer than the window: a new outage.
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
  });
});
