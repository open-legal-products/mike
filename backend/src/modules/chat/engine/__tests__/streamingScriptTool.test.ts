import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// run_script inside a real runLLMStream: when it is offered, how its calls
// leave the model's batch, and how each call a script makes goes through the
// ordinary dispatcher (stand-in here) with its own read state, while the
// documents it reads still land in the turn's events. The script itself runs
// in the real pi-codemode sandbox.

type DispatchedCall = { id: string; function: { name: string; arguments: string } };

const { streamChatWithTools, runToolCalls } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
    fullText: "",
  })),
  runToolCalls: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../../../../lib/integrations/googleDrive", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/integrations/googleDrive")>()),
  buildGoogleDriveTools: vi.fn(async () => []),
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/integrations/googleWorkspace")>()),
  buildGoogleWorkspaceTools: vi.fn(async () => []),
}));
vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: (...args: unknown[]) => runToolCalls(...args),
}));

import { runLLMStream } from "../streaming";
import { SCRIPT_TOOL_NAME } from "../tools/scriptTool";
import { PROJECT_EXTRA_TOOLS } from "../tools/toolSchemas";
import { emptyToolCallBatchResult } from "../tools/toolBatchResult";

type RunToolsFn = (
  calls: { id: string; name: string; input: Record<string, unknown> }[],
) => Promise<{ tool_use_id: string; content: string }[]>;

type StreamChatCall = {
  tools: { function: { name: string; description: string } }[];
  runTools?: RunToolsFn;
  [key: string]: unknown;
};

const DOCS = [
  { doc_id: "doc-0", filename: "Supply A.docx" },
  { doc_id: "doc-1", filename: "Supply B.docx" },
];

/** Answers like the dispatcher: a result per call, and a doc_read for reads. */
function dispatcher() {
  runToolCalls.mockImplementation(async (...args: unknown[]) => {
    const calls = args[0] as DispatchedCall[];
    const options = args[14] as { results?: ReturnType<typeof emptyToolCallBatchResult> };
    const results = options.results ?? emptyToolCallBatchResult();
    for (const call of calls) {
      const input = JSON.parse(call.function.arguments) as Record<string, unknown>;
      let content: unknown = { ok: true };
      if (call.function.name === "list_documents") content = DOCS;
      if (call.function.name === "find_in_document") {
        const hit = input.doc_id === "doc-1";
        content = {
          ok: true,
          total_matches: hit ? 1 : 0,
          hits: hit ? [{ index: 4, excerpt: "x", context: "x" }] : [],
        };
        results.docsFound.push({
          filename: DOCS.find((d) => d.doc_id === input.doc_id)!.filename,
          document_id: `uuid-${input.doc_id}`,
          version_id: null,
          version_number: null,
          query: String(input.query),
          total_matches: hit ? 1 : 0,
        } as never);
      }
      results.toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(content),
      } as never);
    }
    return results;
  });
}

function params() {
  return {
    model: "gemini-3-flash-preview",
    apiMessages: [{ role: "user", content: "Which agreements have change of control?" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    extraTools: PROJECT_EXTRA_TOOLS,
  };
}

const advertised = () =>
  (streamChatWithTools.mock.calls[0]?.[0] as StreamChatCall).tools;

const SCRIPT = `
  const documents = await tools.list_documents({});
  const hits = [];
  for (const d of documents) {
    const r = await tools.find_in_document({ doc_id: d.doc_id, query: "change of control" });
    if (r.total_matches) hits.push(d.filename);
  }
  return hits;
`;

/** Has the model call the given tools once, and keeps what it got back. */
function modelCalls(calls: Parameters<RunToolsFn>[0]) {
  const seen: { results?: Awaited<ReturnType<RunToolsFn>> } = {};
  streamChatWithTools.mockImplementation(async (p: StreamChatCall) => {
    seen.results = await p.runTools?.(calls);
    return { fullText: "" };
  });
  return seen;
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
  dispatcher();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("run_script in a chat turn", () => {
  it("is not offered, and not callable, unless SCRIPT_TOOL=on", async () => {
    vi.stubEnv("SCRIPT_TOOL", "off");
    modelCalls([{ id: "s1", name: SCRIPT_TOOL_NAME, input: { code: SCRIPT } }]);
    await runLLMStream(params());
    expect(advertised().map((t) => t.function.name)).not.toContain(SCRIPT_TOOL_NAME);
    // Unknown to this turn, the call falls to the dispatcher like any other
    // name (which answers an unknown tool as unavailable); no script runs.
    const batches = runToolCalls.mock.calls.map((c) =>
      (c[0] as DispatchedCall[]).map((call) => call.function.name),
    );
    expect(batches).toEqual([[SCRIPT_TOOL_NAME]]);
  });

  it("is offered with the turn's read-only tools declared", async () => {
    vi.stubEnv("SCRIPT_TOOL", "on");
    await runLLMStream(params());
    const script = advertised().find((t) => t.function.name === SCRIPT_TOOL_NAME);
    expect(script).toBeDefined();
    expect(script!.function.description).toContain("list_documents(");
    expect(script!.function.description).toContain("read_document(");
    expect(script!.function.description).not.toContain("edit_document(");
  });

  it("runs the script, dispatching each call on its own, and answers the model", async () => {
    vi.stubEnv("SCRIPT_TOOL", "on");
    const seen = modelCalls([
      { id: "r1", name: "read_document", input: { doc_id: "doc-0" } },
      { id: "s1", name: SCRIPT_TOOL_NAME, input: { code: SCRIPT } },
    ]);
    const result = await runLLMStream(params());

    // The model's own batch holds only its own call; the script never
    // reaches the dispatcher as a tool.
    const batches = runToolCalls.mock.calls.map((c) =>
      (c[0] as DispatchedCall[]).map((call) => call.function.name),
    );
    expect(batches).toEqual([
      ["read_document"],
      ["list_documents"],
      ["find_in_document"],
      ["find_in_document"],
    ]);
    // Script calls carry ids under the script call's id.
    const scriptCallIds = runToolCalls.mock.calls
      .slice(1)
      .map((c) => (c[0] as DispatchedCall[])[0].id);
    expect(scriptCallIds.every((id) => id.startsWith("s1:"))).toBe(true);

    // The script's reads do not count as the model's: a separate read state.
    const mainReadState = runToolCalls.mock.calls[0][9];
    const scriptReadStates = runToolCalls.mock.calls.slice(1).map((c) => c[9]);
    expect(scriptReadStates.every((s) => s instanceof Map && s !== mainReadState)).toBe(true);
    // ...and are the same for every call within one script.
    expect(new Set(scriptReadStates).size).toBe(1);

    // Both calls answered, in the model's order.
    expect(seen.results?.map((r) => r.tool_use_id)).toEqual(["r1", "s1"]);
    expect(JSON.parse(seen.results![1].content)).toEqual({
      ok: true,
      value: ["Supply B.docx"],
      tool_calls: 3,
    });

    // What the script looked at is part of the stored turn.
    const finds = result.events.filter((e) => e.type === "doc_find");
    expect(finds).toHaveLength(2);
  });

  it("hides a failed inner call's internal error from the script", async () => {
    vi.stubEnv("SCRIPT_TOOL", "on");
    // The model's own (empty) batch goes first; the script's call fails.
    const answer = runToolCalls.getMockImplementation()!;
    let n = 0;
    runToolCalls.mockImplementation(async (...args: unknown[]) => {
      n += 1;
      if (n === 2) throw new Error("database is down");
      return answer(...args);
    });
    const seen = modelCalls([
      {
        id: "s1",
        name: SCRIPT_TOOL_NAME,
        input: { code: `try { await tools.list_documents({}); } catch (e) { return e.message; }` },
      },
    ]);
    await runLLMStream(params());
    const content = JSON.parse(seen.results![0].content);
    expect(content).toMatchObject({ ok: true, value: "list_documents failed." });
    expect(seen.results![0].content).not.toContain("database is down");
  });
});
