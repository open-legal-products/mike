/**
 * run_script against the real pi-codemode sandbox (QuickJS on a worker
 * thread) with a stand-in dispatcher: what a script can reach, how its
 * calls are dispatched, and every way it can end.
 */
import { describe, expect, it, vi } from "vitest";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn(() => null) }));
vi.mock("../../../../lib/observability/sentry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/observability/sentry")>()),
  reportError,
}));

import type { NormalizedToolCall, OpenAIToolSchema } from "../../../../lib/llm/types";
import {
  runScriptCall,
  SCRIPT_TOOL_NAME,
  scriptInnerTools,
  scriptToolEnabled,
  scriptToolFor,
  type ScriptToolDispatch,
} from "./scriptTool";
import { PROJECT_EXTRA_TOOLS, TOOLS } from "./toolSchemas";

const ACTIVE = [...TOOLS, ...PROJECT_EXTRA_TOOLS] as OpenAIToolSchema[];
const INNER = scriptInnerTools(ACTIVE);

const DOCS = [
  { doc_id: "doc-0", filename: "Supply A.docx" },
  { doc_id: "doc-1", filename: "Supply B.docx" },
  { doc_id: "doc-2", filename: "NDA.pdf" },
];

type FakeDispatch = ScriptToolDispatch & {
  calls: Array<[string, Record<string, unknown>, string]>;
};

/** A dispatcher that answers like the real tools, from fixed documents. */
function fakeDispatch(): FakeDispatch {
  const calls: Array<[string, Record<string, unknown>, string]> = [];
  const dispatch = (async (name, args, callId) => {
    calls.push([name, args, callId]);
    if (name === "list_documents") return JSON.stringify({ documents: DOCS });
    if (name === "find_in_document") {
      const hit = args.doc_id === "doc-1";
      return JSON.stringify({
        doc_id: args.doc_id,
        total_matches: hit ? 1 : 0,
        matches: hit ? [{ excerpt: "upon a Change of Control", page: 4 }] : [],
      });
    }
    if (name === "read_document") return "plain text, not JSON";
    return JSON.stringify({ error: `Tool '${name}' is not available.` });
  }) as FakeDispatch;
  dispatch.calls = calls;
  return dispatch;
}

const call = (code: unknown, id = "s1"): NormalizedToolCall => ({
  id,
  name: SCRIPT_TOOL_NAME,
  input: { code },
});

const run = (code: string, overrides: Partial<Parameters<typeof runScriptCall>[1]> = {}) => {
  const dispatch = (overrides.dispatch ?? fakeDispatch()) as FakeDispatch;
  return runScriptCall(call(code), { innerTools: INNER, dispatch, ...overrides }).then(
    (text) => ({ text, result: JSON.parse(text) as Record<string, unknown>, dispatch }),
  );
};

describe("scriptToolEnabled", () => {
  it("is off unless SCRIPT_TOOL=on", () => {
    expect(scriptToolEnabled({})).toBe(false);
    expect(scriptToolEnabled({ SCRIPT_TOOL: "true" })).toBe(false);
    expect(scriptToolEnabled({ SCRIPT_TOOL: " ON " })).toBe(true);
  });
});

describe("scriptToolFor", () => {
  it("is null when the flag is off", async () => {
    expect(await scriptToolFor(ACTIVE, {})).toBeNull();
  });

  it("is null when the turn offers no tool a script may call", async () => {
    const writersOnly = ACTIVE.filter((t) => t.function.name === "edit_document");
    expect(await scriptToolFor(writersOnly, { SCRIPT_TOOL: "on" })).toBeNull();
  });

  it("declares only allowlisted tools the turn offers", async () => {
    const schema = await scriptToolFor(ACTIVE, { SCRIPT_TOOL: "on" });
    expect(schema?.function.name).toBe(SCRIPT_TOOL_NAME);
    const description = schema!.function.description;
    for (const name of ["read_document", "find_in_document", "list_documents", "fetch_documents", "find_documents"]) {
      expect(description).toContain(`${name}(`);
    }
    for (const name of ["edit_document", "replicate_document", "ask_inputs", "generate_docx"]) {
      expect(description).not.toContain(`${name}(`);
    }
    // read_table_cells is allowlisted but not offered in this turn.
    expect(description).not.toContain("read_table_cells(");
    expect(schema!.function.parameters).toMatchObject({ required: ["code"] });
  });

  it("never exposes a writer even if one is offered", () => {
    const names = INNER.map((t) => t.function.name);
    expect(names).not.toContain("edit_document");
    expect(names).toEqual(
      expect.arrayContaining(["read_document", "find_in_document", "list_documents"]),
    );
  });
});

describe("runScriptCall", () => {
  it("loops over documents through the dispatcher and returns the script's value", async () => {
    const { result, dispatch } = await run(`
      const { documents } = await tools.list_documents({});
      const hits = [];
      for (const d of documents) {
        const r = await tools.find_in_document({ doc_id: d.doc_id, query: "change of control" });
        if (r.total_matches) hits.push({ doc: d.filename, page: r.matches[0].page });
      }
      console.log("checked", documents.length);
      return hits;
    `);
    expect(result).toEqual({
      ok: true,
      value: [{ doc: "Supply B.docx", page: 4 }],
      tool_calls: 4,
      output: "checked 3",
    });
    expect(dispatch.calls.map(([name]) => name)).toEqual([
      "list_documents",
      "find_in_document",
      "find_in_document",
      "find_in_document",
    ]);
    // Each inner call has its own id under the script's call id.
    expect(new Set(dispatch.calls.map(([, , id]) => id)).size).toBe(4);
    expect(dispatch.calls.every(([, , id]) => id.startsWith("s1:"))).toBe(true);
  });

  it("returns non-JSON tool results as text", async () => {
    const { result } = await run(`return await tools.read_document({ doc_id: "doc-0" });`);
    expect(result).toMatchObject({ ok: true, value: "plain text, not JSON" });
  });

  it("runs concurrent calls one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const dispatch: ScriptToolDispatch = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return "{}";
    };
    const { result } = await run(
      `await Promise.all([1,2,3,4].map((i) => tools.read_document({ doc_id: "doc-" + i }))); return "ok";`,
      { dispatch },
    );
    expect(result).toMatchObject({ ok: true, value: "ok" });
    expect(maxActive).toBe(1);
  });

  it("refuses arguments that do not match a tool's schema before dispatching", async () => {
    const { result, dispatch } = await run(`
      try { await tools.read_document({ doc: "doc-0" }); }
      catch (e) { return e.message; }
    `);
    expect(String(result.value)).toContain("/doc_id");
    expect(String(result.value)).toContain("Nothing ran");
    expect(dispatch.calls).toHaveLength(0);
  });

  it("cannot reach a tool that is not exposed", async () => {
    const dispatch = fakeDispatch();
    const { result } = await run(`return await tools.edit_document({ doc_id: "doc-0" });`, {
      dispatch,
    });
    expect(result).toMatchObject({ ok: false, error: "The script threw an error." });
    expect(String(result.detail)).toContain("TypeError: tools.edit_document does not exist");
    const listed = await run(`return Object.keys(tools).sort();`);
    expect(listed.result.value).toEqual(
      INNER.map((t) => t.function.name).sort(),
    );
    expect(dispatch.calls).toHaveLength(0);
  });

  it("has no network, timers, process or modules", async () => {
    const { result } = await run(
      `return [typeof fetch, typeof setTimeout, typeof process, typeof require, typeof XMLHttpRequest];`,
    );
    expect(result).toMatchObject({
      ok: true,
      value: ["undefined", "undefined", "undefined", "undefined", "undefined"],
    });
  });

  it("stops a script at its tool-call limit", async () => {
    const { result } = await run(
      `let n = 0;
       try { for (;;) { await tools.list_documents({}); n++; } }
       catch (e) { return { n, message: e.message }; }`,
      { limits: { maxToolCalls: 3 } },
    );
    expect(result.value).toEqual({
      n: 3,
      message: "This script reached its limit of 3 tool calls.",
    });
  });

  it("reports a script's own error with its message", async () => {
    const { result } = await run(`throw new RangeError("no documents matched");`);
    expect(result).toMatchObject({
      ok: false,
      error: "The script threw an error.",
      detail: "RangeError: no documents matched",
    });
  });

  it("reports a syntax error as a script error", async () => {
    const { result } = await run(`return (;`);
    expect(result).toMatchObject({ ok: false, error: "The script threw an error." });
  });

  it("ends a script that never finishes", async () => {
    const { result } = await run(`for (;;) {}`, { limits: { timeoutMs: 300 } });
    expect(result).toMatchObject({ ok: false, error: "The script ran out of time." });
  });

  it("stops when the turn is stopped", async () => {
    const controller = new AbortController();
    const dispatch: ScriptToolDispatch = async () => {
      controller.abort();
      return "{}";
    };
    const { result } = await run(
      `for (;;) await tools.list_documents({});`,
      { dispatch, signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false, error: "The script was stopped." });
  });

  it("hides a dispatcher failure's internal message from the script", async () => {
    const dispatch: ScriptToolDispatch = async () => {
      throw new Error("relation documents does not exist (db host 10.0.0.5)");
    };
    const { text, result } = await run(
      `try { await tools.list_documents({}); } catch (e) { return e.message; }`,
      { dispatch },
    );
    expect(result).toMatchObject({ ok: true, value: "list_documents failed." });
    expect(text).not.toContain("10.0.0.5");
    // Swallowed for the script, but reported with static labels and the cause kept.
    expect(reportError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportError.mock.calls[0] as unknown as [
      Error & { kind?: string; cause?: unknown },
      { tags: Record<string, string> },
    ];
    expect(reported.kind).toBe("chat.tool_failed");
    expect((reported.cause as Error).message).toContain("10.0.0.5");
    expect(context.tags).toEqual({ component: "chat-stream", operation: "chat.script_tool" });
  });

  it("replaces an oversized result with a valid JSON preview", async () => {
    const { text, result } = await run(`return "x".repeat(5000);`, {
      limits: { maxResultChars: 400 },
    });
    expect(text.length).toBeLessThan(600);
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toContain("longer than 400 characters");
    expect(String(result.preview)).toMatch(/^\{"ok":true,"value":"x+/);
  });

  it("refuses when too many scripts are running", async () => {
    const { result } = await run(`return 1;`, { limits: { maxConcurrent: 0 } });
    expect(result).toMatchObject({ ok: false });
    expect(String(result.error)).toContain("Too many scripts");
  });

  it("refuses an empty or missing script without starting a sandbox", async () => {
    const dispatch = vi.fn<ScriptToolDispatch>();
    for (const code of ["", "   ", undefined, 42]) {
      const text = await runScriptCall(call(code), { innerTools: INNER, dispatch });
      expect(JSON.parse(text)).toMatchObject({ ok: false });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses when no tools are exposed", async () => {
    const text = await runScriptCall(call("return 1"), {
      innerTools: [],
      dispatch: fakeDispatch(),
    });
    expect(JSON.parse(text)).toMatchObject({ ok: false });
  });
});
