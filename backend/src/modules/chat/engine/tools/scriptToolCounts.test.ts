/**
 * What run_script counts, against the real sandbox: how each script ended,
 * the limits it met, and the calls it made.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NormalizedToolCall, OpenAIToolSchema } from "../../../../lib/llm/types";
import {
  flushToolActivity,
  setToolActivitySinkForTests,
  type ToolActivityCount,
} from "../../../../lib/toolActivity";
import {
  runScriptCall,
  SCRIPT_TOOL_NAME,
  scriptInnerTools,
  type ScriptRunContext,
} from "./scriptTool";
import { PROJECT_EXTRA_TOOLS, TOOLS } from "./toolSchemas";

const INNER = scriptInnerTools([...TOOLS, ...PROJECT_EXTRA_TOOLS] as OpenAIToolSchema[]);

const call = (code: unknown): NormalizedToolCall => ({
  id: "s1",
  name: SCRIPT_TOOL_NAME,
  input: { code },
});

let counted: ToolActivityCount[];
beforeEach(() => {
  counted = [];
  setToolActivitySinkForTests((counts) => {
    counted.push(...counts.map((count) => ({ ...count })));
  });
});
afterEach(() => setToolActivitySinkForTests(null));

async function run(code: unknown, context: Partial<ScriptRunContext> = {}) {
  const answer = await runScriptCall(call(code), {
    innerTools: INNER,
    dispatch: async (name) => {
      if (name === "read_document") throw new Error("storage is down");
      return JSON.stringify([{ doc_id: "doc-0", filename: "NDA.pdf" }]);
    },
    ...context,
  });
  flushToolActivity();
  return answer;
}

const count = (kind: string, tool: string, outcome: string) =>
  counted
    .filter((c) => c.kind === kind && c.tool === tool && c.outcome === outcome)
    .reduce((sum, c) => sum + c.count, 0);
const runs = (outcome: string) => count("script_run", SCRIPT_TOOL_NAME, outcome);

describe("run_script counts", () => {
  it("counts a finished script and each call it made", async () => {
    await run(`const a = await tools.list_documents({}); const b = await tools.list_documents({}); return a.length + b.length;`);
    expect(runs("ok")).toBe(1);
    expect(count("script_tool_call", "list_documents", "ok")).toBe(2);
    expect(counted.filter((c) => c.kind === "script_run")).toHaveLength(1);
  });

  it("counts a script that threw, one that ran out of time, and one never run", async () => {
    await run(`throw new Error("no such clause");`);
    expect(runs("script_error")).toBe(1);
    await run(`while (true) {}`, { limits: { timeoutMs: 200 } });
    expect(runs("timeout")).toBe(1);
    await run("   ");
    expect(runs("rejected_input")).toBe(1);
  });

  it("counts a result too long to return apart from a clean finish", async () => {
    await run(`return "x".repeat(5000);`, { limits: { maxResultChars: 1000 } });
    expect(runs("ok_result_too_long")).toBe(1);
    expect(runs("ok")).toBe(0);
  });

  it("counts the call limit once for a script that met it, and the stop for one that kept calling", async () => {
    await run(
      `await tools.list_documents({}); try { await tools.list_documents({}); } catch {} return "partial";`,
      { limits: { maxToolCalls: 1 } },
    );
    expect(count("script_limit", SCRIPT_TOOL_NAME, "call_limit")).toBe(1);
    expect(runs("ok")).toBe(1);

    await run(
      `for (let i = 0; i < 50; i += 1) { try { await tools.list_documents({}); } catch {} } return 1;`,
      { limits: { maxToolCalls: 1 } },
    );
    expect(count("script_limit", SCRIPT_TOOL_NAME, "call_limit")).toBe(2);
    expect(runs("stopped_over_call_limit")).toBe(1);
  });

  it("counts a script call its schema refused and one whose tool failed", async () => {
    await run(
      `try { await tools.find_in_document({}); } catch {} try { await tools.read_document({ doc_id: "doc-0" }); } catch {} return 1;`,
    );
    expect(count("script_tool_input", "find_in_document", "refused")).toBe(1);
    expect(count("script_tool_input", "read_document", "passed")).toBe(1);
    expect(count("script_tool_call", "read_document", "failed")).toBe(1);
    expect(runs("ok")).toBe(1);
  });

  it("counts a script refused because too many are running", async () => {
    await run(`return 1;`, { limits: { maxConcurrent: 0 } });
    expect(runs("refused_busy")).toBe(1);
  });
});
