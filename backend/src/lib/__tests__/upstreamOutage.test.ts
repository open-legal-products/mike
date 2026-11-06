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
    expect(warn).toHaveBeenCalledTimes(1);
    clock += 10_000;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    clock += 60_000;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]![0])).toContain("3 request(s) not re-reported");
  });

  it("treats a different class as news", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    expect(shouldReportUpstreamFailure(authError(503))).toBe(true);
    expect(shouldReportUpstreamFailure(authError(503))).toBe(false);
  });

  it("reports a persisting outage again after 15 minutes", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    clock += 15 * 60_000 - 1;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(false);
    clock += 1;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
  });

  it("reports the next outage at once after a successful auth call", () => {
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
    noteUpstreamReachable();
    clock += 1_000;
    expect(shouldReportUpstreamFailure(authError(0))).toBe(true);
  });
});
