/**
 * run_script when pi-codemode cannot be loaded: the turn keeps its ordinary
 * tools, the failure is reported, and the failed load is not kept.
 */
import { describe, expect, it, vi } from "vitest";

const { reportError, load } = vi.hoisted(() => ({
  reportError: vi.fn(() => null),
  load: { fail: true },
}));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/observability/sentry")>()),
  reportError,
}));
vi.mock("@earendil-works/pi-codemode", async (importOriginal) => {
  if (load.fail) throw new Error("Cannot find package");
  return importOriginal();
});

import type { OpenAIToolSchema } from "../../../../lib/llm/types";
import { runScriptCall, SCRIPT_TOOL_NAME, scriptInnerTools, scriptToolFor } from "./scriptTool";
import { PROJECT_EXTRA_TOOLS, TOOLS } from "./toolSchemas";

const ACTIVE = [...TOOLS, ...PROJECT_EXTRA_TOOLS] as OpenAIToolSchema[];

describe("run_script without its sandbox", () => {
  it("is not offered, and a call fails without failing the turn", async () => {
    expect(await scriptToolFor(ACTIVE, { SCRIPT_TOOL: "on" })).toBeNull();
    const text = await runScriptCall(
      { id: "s1", name: SCRIPT_TOOL_NAME, input: { code: "return 1;" } },
      { innerTools: scriptInnerTools(ACTIVE), dispatch: async () => "{}" },
    );
    expect(JSON.parse(text)).toMatchObject({ ok: false });
    expect(text).toContain("sandbox failed");
    expect(reportError).toHaveBeenCalledTimes(2);
    const [error, context] = reportError.mock.calls[0] as unknown as [
      { kind: string },
      { tags: Record<string, string> },
    ];
    expect(error.kind).toBe("chat.script_sandbox_failed");
    expect(context.tags).toEqual({ component: "chat-stream", operation: "chat.script_tool" });
  });
});
