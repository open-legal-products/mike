import { afterEach, expect, it, vi } from "vitest";
import { installProviderWarningLogger, logProviderWarnings } from "./warnings";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("handles compatibility notices locally but retains actionable deprecations", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  logProviderWarnings({ provider: "test", warnings: [{ type: "unsupported", feature: "reasoning" }] });
  expect(warn).toHaveBeenCalledTimes(1);
  expect(emit).not.toHaveBeenCalled();
  logProviderWarnings({ provider: "test", warnings: [{ type: "deprecated", setting: "old-setting", message: "PRIVATE_NOTICE" }] });
  expect(emit).toHaveBeenCalledWith(expect.not.stringContaining("PRIVATE_NOTICE"), { type: "DeprecationWarning", code: "AI_SDK_DEPRECATION" });
  logProviderWarnings({ warnings: [{ type: "other", message: "PRIVATE_NOTICE" }] });
  expect(emit).toHaveBeenLastCalledWith(expect.not.stringContaining("PRIVATE_NOTICE"), { code: "AI_SDK_WARNING" });
});
it("respects an operator's existing warning logger or opt-out", () => {
  for (const setting of [false, vi.fn()]) {
    vi.stubGlobal("AI_SDK_LOG_WARNINGS", setting);
    installProviderWarningLogger();
    expect((globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS).toBe(setting);
  }
});
