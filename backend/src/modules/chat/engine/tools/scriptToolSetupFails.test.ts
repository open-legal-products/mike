/**
 * run_script when pi-codemode loads but setting the tool up fails: the tool
 * is optional, so the turn keeps its ordinary tools and the failure is
 * reported.
 */
import { describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/observability/sentry")>()),
  reportError,
}));
vi.mock("@earendil-works/pi-codemode", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-codemode")>()),
  renderDeclarations: () => {
    throw new Error("cannot render");
  },
}));

import type { OpenAIToolSchema } from "../../../../lib/llm/types";
import { scriptToolFor } from "./scriptTool";
import { PROJECT_EXTRA_TOOLS, TOOLS } from "./toolSchemas";

describe("run_script when its setup fails", () => {
  it("is not offered and does not fail the turn", async () => {
    const active = [...TOOLS, ...PROJECT_EXTRA_TOOLS] as OpenAIToolSchema[];
    expect(await scriptToolFor(active, { SCRIPT_TOOL: "on" })).toBeNull();
    expect(reportError).toHaveBeenCalledTimes(1);
    const [error] = reportError.mock.calls[0] as unknown as [{ kind: string }];
    expect(error.kind).toBe("chat.script_sandbox_failed");
  });
});
