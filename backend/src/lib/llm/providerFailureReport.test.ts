import { afterEach, expect, it, vi } from "vitest";
const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../observability/sentry", () => ({ reportError }));
import { reportModelFailure } from "./providerFailureReport";
import { withKeySource } from "./providerErrors";
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });
it.each([[503, "warning"], [400, "error"], [402, "error"]] as const)("preserves an unowned %i failure at %s", (statusCode, level) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const cause = Object.assign(new Error("private provider detail"), { statusCode });
  const failure = new Error("operation failed", { cause });
  reportModelFailure(failure, { tags: { operation: "chat.turn" } }, "[test]");
  expect(reportError).toHaveBeenCalledWith(failure, { level, tags: { operation: "chat.turn" } });
});
it("keeps repeated deployment refusals eligible and never downgrades them from UI classification", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (let i = 0; i < 2; i++) reportModelFailure(withKeySource(Object.assign(new Error("refused"), { statusCode: 401 }), "deployment"), { level: "warning" }, "[test]");
  expect(reportError).toHaveBeenCalledTimes(2);
  expect(reportError.mock.calls[1][1]).toMatchObject({ level: "error" });
});
