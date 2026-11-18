import { expect, it, vi } from "vitest";
import type * as Codemode from "@earendil-works/pi-codemode" with { "resolution-mode": "import" };

const { reportError, loadWasm } = vi.hoisted(() => ({
  reportError: vi.fn(),
  loadWasm: vi.fn(),
}));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/observability/sentry")>()),
  reportError,
}));
vi.mock("@earendil-works/pi-codemode", async (importOriginal) => {
  const actual = await importOriginal<typeof Codemode>();
  loadWasm.mockImplementation(actual.loadQuickJSWasm);
  return { ...actual, loadQuickJSWasm: loadWasm };
});

import { runScriptCall, scriptInnerTools } from "./scriptTool";
import { TOOLS } from "./toolSchemas";

it("reports a synchronous WASM load failure as a tool result and retries successfully", async () => {
  // Load the mock before configuring its one-shot failure.
  await import("@earendil-works/pi-codemode");
  loadWasm.mockImplementationOnce(() => { throw new Error("WASM file missing"); });
  const run = () => runScriptCall(
    { id: "s1", name: "run_script", input: { code: "return 42;" } },
    { innerTools: scriptInnerTools(TOOLS), dispatch: vi.fn(), userId: "wasm-user", limits: { maxConcurrent: 1 } },
  ).then(JSON.parse);
  expect(await run()).toMatchObject({ ok: false, error: expect.stringContaining("sandbox failed") });
  expect(reportError).toHaveBeenCalledTimes(1);
  expect(reportError.mock.calls[0][0].kind).toBe("chat.script_sandbox_failed");
  expect(await run()).toMatchObject({ ok: true, value: 42 });
  expect(loadWasm).toHaveBeenCalledTimes(2);
});
