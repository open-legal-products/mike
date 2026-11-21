import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../observability/sentry", () => ({ reportError }));
import { installProviderWarningLogger, logProviderWarnings, resetProviderWarningsForTests } from "./warnings";
beforeEach(() => { resetProviderWarningsForTests(); vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("handles compatibility locally and reports source-identifiable deprecations", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  logProviderWarnings({ provider: "test", warnings: [{ type: "unsupported", feature: "reasoning" }] });
  expect(reportError).not.toHaveBeenCalled();
  logProviderWarnings({ warnings: [{ type: "deprecated", setting: "generateObject", message: "PRIVATE_NOTICE" }] });
  expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
    level: "warning", tags: { component: "provider-warning", operation: "llm.warning", warning_name: "DeprecationWarning", warning_code: "AISDK_DEP_GENERATE_OBJECT" },
  });
  expect(reportError.mock.calls[0]?.[0].message).not.toContain("PRIVATE_NOTICE");
});
it("respects an operator's existing warning logger or opt-out", () => {
  for (const setting of [false, vi.fn()]) {
    vi.stubGlobal("AI_SDK_LOG_WARNINGS", setting);
    installProviderWarningLogger();
    expect((globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS).toBe(setting);
  }
});
it("preserves Node's explicit deprecation reporting opt-out", () => {
  const original = process.noDeprecation;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    process.noDeprecation = true;
    logProviderWarnings({ warnings: [{ type: "deprecated", setting: "generateObject" }] });
    expect(reportError).not.toHaveBeenCalled();
  } finally { process.noDeprecation = original; }
});
it("bounds repeat warnings without permanently suppressing them or starving new warnings", () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const warning = { type: "other", message: "first unknown warning" };
  for (let attempt = 0; attempt < 20; attempt++) logProviderWarnings({ warnings: [warning] });
  expect(reportError).toHaveBeenCalledTimes(1);
  logProviderWarnings({ warnings: [{ type: "other", message: "different unknown warning" }] });
  expect(reportError).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(5 * 60_000);
  logProviderWarnings({ warnings: [warning] });
  expect(reportError).toHaveBeenCalledTimes(3);
});
