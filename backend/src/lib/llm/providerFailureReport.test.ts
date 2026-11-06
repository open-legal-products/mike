import { afterEach, describe, expect, it, vi } from "vitest";

const { reportError, acknowledgeUnreported } = vi.hoisted(() => ({
  reportError: vi.fn(),
  acknowledgeUnreported: vi.fn(),
}));
vi.mock("../observability/sentry", () => ({ reportError, acknowledgeUnreported }));

import { reportModelFailure } from "./providerFailureReport";

function apiCallError(statusCode: number) {
  return Object.assign(new Error(`Request failed (${statusCode})`), {
    name: "AI_APICallError",
    statusCode,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("reportModelFailure", () => {
  // context.level may only quieten: a caller asking for "error" on a
  // provider outage must not turn a warning into an error.
  it("keeps a 503 at warning when the caller asks for error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportModelFailure(apiCallError(503), { level: "error" }, "[test]");
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("lets the caller quieten an unexplained failure to a warning", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportModelFailure(apiCallError(400), { level: "warning" }, "[test]");
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ level: "warning" }),
    );
  });

  it("uses the provider's level when the caller names none", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    reportModelFailure(apiCallError(400), {}, "[test]");
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ level: "error" }),
    );
  });

  it("never brings an unreported account condition back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportModelFailure(apiCallError(402), { level: "error" }, "[test]");
    expect(reportError).not.toHaveBeenCalled();
    expect(acknowledgeUnreported).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
