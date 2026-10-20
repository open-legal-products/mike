import { beforeEach, describe, expect, it, vi } from "vitest";

type DispatchedCall = { id: string; function: { name: string } };

function toolBatch(calls: DispatchedCall[], askInputsEvents: unknown[] = []) {
  return {
    toolResults: calls.map((c) => ({ tool_call_id: c.id, content: `${c.function.name} result` })),
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents,
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  };
}

const { streamChatWithTools, runToolCalls, buildUserMcpTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
    fullText: "",
  })),
  runToolCalls: vi.fn(async (calls: DispatchedCall[], ..._rest: unknown[]) => toolBatch(calls)),
  buildUserMcpTools: vi.fn(async () => [
    { type: "function", function: { name: "mcp_mail_send", parameters: {} } },
  ]),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools }));

vi.mock("../tools/toolDispatcher", () => ({ runToolCalls }));

import type { DelegationEvent } from "@mike/contracts";
import { buildMessages, spotlight } from "../contextBuilders";
import { runLLMStream } from "../streaming";
import {
  createDelegateTurnState,
  runDelegateCall,
  type DelegateContext,
} from "../tools/delegateTools";
import { readDocumentContent } from "../tools/documentOps";
import { createWebTurnState } from "../tools/webSearchTools";

type ToolResult = { tool_use_id: string; content: string };
type StreamChatCall = {
  model: string;
  reasoning?: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  tools: { function: { name: string; parameters?: unknown } }[];
  abortSignal?: AbortSignal;
  callbacks?: {
    onToolCallStart?: (call: ReturnType<typeof delegate> & { invalid?: true }) => void;
    onContentDelta?: (text: string) => void;
    onUsage?: (
      usage: { inputTokens: number; outputTokens: number },
      finishReason: string,
    ) => void;
  };
  runTools?: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<ToolResult[]>;
};

const isSubagent = (params: StreamChatCall) =>
  params.systemPrompt.includes("SUBAGENT:");

const delegate = (id: string, input: Record<string, unknown> = {}) => ({
  id,
  name: "delegate",
  input: { title: `Task ${id}`, task: "Summarise doc-0.", ...input },
});

/** The subagent's stream, cut off by its abort signal like the SDK would. */
function untilAborted(params: StreamChatCall) {
  return new Promise<never>((_, reject) => {
    const abort = () => {
      const error = new Error("Stream aborted.");
      error.name = "AbortError";
      reject(error);
    };
    if (params.abortSignal?.aborted) abort();
    else params.abortSignal?.addEventListener("abort", abort);
  });
}

function parentDelegates(
  calls: ReturnType<typeof delegate>[],
  subagent: (params: StreamChatCall) => Promise<{ fullText: string }>,
) {
  const parentResults: ToolResult[][] = [];
  streamChatWithTools.mockImplementation(async (params) => {
    if (isSubagent(params)) return subagent(params);
    parentResults.push((await params.runTools?.(calls)) ?? []);
    params.callbacks?.onContentDelta?.("Answer");
    return { fullText: "Answer" };
  });
  return parentResults;
}

const runStore = () => ({ save: vi.fn(), load: vi.fn(async () => null) });

function baseParams() {
  return {
    model: "gemini-3.8-flash",
    apiMessages: [
      { role: "system", content: "Base prompt." },
      { role: "user", content: "Review the lease." },
    ],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
    subagentRuns: runStore(),
  };
}

const delegationsIn = (events: { type: string }[]) =>
  events.filter((e): e is DelegationEvent => e.type === "delegation");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runLLMStream delegation", () => {
  it("gives a subagent every tool but delegate, ask_inputs and create_text_card, at both the schema and the call", async () => {
    let subagentTools: string[] = [];
    let subagentResults: ToolResult[] = [];
    parentDelegates([delegate("d1")], async (params) => {
      subagentTools = params.tools.map((t) => t.function.name);
      subagentResults =
        (await params.runTools?.([
          { id: "ask", name: "ask_inputs", input: {} },
          { id: "edit", name: "edit_document", input: { doc_id: "doc-0" } },
        ])) ?? [];
      return { fullText: "Brief." };
    });

    await runLLMStream(baseParams());

    expect(subagentTools).toEqual(
      expect.arrayContaining(["edit_document", "generate_docx", "mcp_mail_send"]),
    );
    expect(subagentTools).not.toContain("ask_inputs");
    expect(subagentTools).not.toContain("delegate");
    expect(subagentTools).not.toContain("create_text_card");
    const dispatched = runToolCalls.mock.calls.flatMap(([calls]) => calls);
    expect(dispatched.map((c) => c.function.name)).toEqual(["edit_document"]);
    expect(subagentResults[0].content).toContain("not available");
  });

  it("offers the chat provider's models and runs a subagent on the one it names", async () => {
    let subagentModel = "";
    parentDelegates([delegate("d1", { model: "gemini-3.1-pro-preview" })], async (params) => {
      subagentModel = params.model;
      return { fullText: "Brief." };
    });

    await runLLMStream({ ...baseParams(), apiKeys: { gemini: "key", openrouter: "key" } });

    const parentTools = streamChatWithTools.mock.calls[0][0].tools;
    const schema = JSON.stringify(parentTools.find((t) => t.function.name === "delegate"));
    expect(schema).toContain("gemini-3.1-pro-preview");
    expect(schema).not.toContain("openrouter");
    expect(subagentModel).toBe("gemini-3.1-pro-preview");
  });

  it("tells the assistant the user's subagent defaults and runs at the reasoning it asks for", async () => {
    let subagentReasoning: string | undefined;
    parentDelegates([delegate("d1", { effort: "quick", reasoning: "high" })], async (params) => {
      subagentReasoning = params.reasoning;
      return { fullText: "Brief." };
    });

    await runLLMStream({
      ...baseParams(),
      subagentDefaults: { model: "gemini-3.1-pro-preview", reasoning: "high" },
    });

    const { systemPrompt } = streamChatWithTools.mock.calls[0][0];
    expect(systemPrompt).toContain("gemini-3.1-pro-preview");
    expect(systemPrompt).toContain("reasoning high");
    expect(subagentReasoning).toBe("high");
  });

  it("keeps the text of a delegated document out of the brief", async () => {
    let subagentPrompt = "";
    parentDelegates([delegate("d1")], async (params) => {
      subagentPrompt = params.systemPrompt;
      return { fullText: "Brief." };
    });

    await runLLMStream(baseParams());

    const { systemPrompt } = streamChatWithTools.mock.calls[0][0];
    expect(systemPrompt).toContain(
      "When the task creates or edits a document, ask for a summary and the list of changes, not the document's text",
    );
    expect(subagentPrompt).toContain(
      "If you created or edited a document, summarise it instead of repeating its text, even if the task asks for the text",
    );
  });

  it("runs delegations in parallel and refuses those past the limit per answer", async () => {
    let running = 0;
    let mostAtOnce = 0;
    const parentResults = parentDelegates(
      Array.from({ length: 9 }, (_, i) => delegate(`d${i}`)),
      async () => {
        mostAtOnce = Math.max(mostAtOnce, ++running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { fullText: "Brief." };
      },
    );

    const result = await runLLMStream(baseParams());

    expect(mostAtOnce).toBe(8);
    expect(parentResults[0][8].content).toContain("limit of 8 subagents");
    expect(delegationsIn(result.events)).toHaveLength(8);
  });

  it("pauses the answer on a subagent's connector approval and asks the user for it", async () => {
    const approval = {
      id: "approval-1",
      kind: "approval",
      connector_name: "Mail",
      tool_name: "send",
      title: "Send email",
      arguments: {},
      binding: { type: "mcp" },
    };
    const isSend = (calls: DispatchedCall[]) =>
      calls.some((c) => c.function.name === "mcp_mail_send");
    runToolCalls.mockImplementation(async (calls) =>
      toolBatch(
        calls,
        isSend(calls) ? [{ type: "ask_inputs", event_id: "e1", items: [approval] }] : [],
      ),
    );
    parentDelegates([delegate("d1")], async (params) => {
      await params.runTools?.([
        { id: "edit", name: "edit_document", input: {} },
        { id: "send", name: "mcp_mail_send", input: {} },
      ]);
      return { fullText: "" };
    });

    const params = { ...baseParams(), connectorApprovals: true };
    const result = await runLLMStream(params);

    const subagentDispatch = runToolCalls.mock.calls.find(([calls]) => isSend(calls));
    expect(subagentDispatch?.[14]).toMatchObject({ connectorApprovals: true });
    const [delegation] = delegationsIn(result.events);
    expect(delegation).toMatchObject({ status: "needs_input", approval_ids: ["approval-1"] });
    expect(delegation.events.map((e) => e.type)).not.toContain("ask_inputs");
    expect(params.subagentRuns.save).toHaveBeenCalledWith(
      delegation.delegation_id,
      "needs_input",
      expect.anything(),
    );
    expect(result.events.filter((e) => e.type === "ask_inputs")).toEqual([
      expect.objectContaining({ items: [{ ...approval, requested_by: "Task d1" }] }),
    ]);
    expect(result.fullText).toBe("");
  });

  it("starts a subagent as soon as the model has written a valid call, not when its step ends", async () => {
    const params = baseParams();
    let subagentRuns = 0;
    streamChatWithTools.mockImplementation(async (call) => {
      if (isSubagent(call)) {
        subagentRuns += 1;
        return { fullText: "Brief." };
      }
      call.callbacks?.onToolCallStart?.({ ...delegate("d2"), invalid: true });
      call.callbacks?.onToolCallStart?.(delegate("d1"));
      await vi.waitFor(() =>
        expect(params.write).toHaveBeenCalledWith(expect.stringContaining('"delegation_start"')),
      );
      await call.runTools?.([delegate("d1")]);
      return { fullText: "" };
    });

    const result = await runLLMStream(params);

    expect(subagentRuns).toBe(1);
    expect(delegationsIn(result.events)).toMatchObject([{ status: "completed" }]);
  });

  it("returns a partial brief when a subagent runs out of budget, and the answer goes on", async () => {
    const parentResults = parentDelegates(
      [delegate("d1", { effort: "quick" })],
      async (params) => {
        params.callbacks?.onContentDelta?.("Partial findings.");
        params.callbacks?.onUsage?.({ inputTokens: 600_000, outputTokens: 0 }, "tool-calls");
        return untilAborted(params);
      },
    );

    const result = await runLLMStream(baseParams());

    expect(result.fullText).toBe("Answer");
    expect(parentResults[0][0].content).toContain("brief is partial");
    expect(parentResults[0][0].content).toContain("Partial findings.");
    expect(delegationsIn(result.events)[0]).toMatchObject({
      status: "incomplete",
      brief: "Partial findings.",
      usage: { input_tokens: 600_000, output_tokens: 0 },
    });
  });

  it("pauses a subagent that asks a question and hands the question back fenced", async () => {
    const parentResults = parentDelegates([delegate("d1")], async (params) => {
      params.callbacks?.onContentDelta?.("Clause 4 has two readings.");
      await params.runTools?.([
        { id: "ask", name: "ask_parent", input: { question: "Which party is the tenant?" } },
      ]);
      return { fullText: "" };
    });

    const result = await runLLMStream(baseParams());

    expect(parentResults[0][0].content).toContain(
      `Question:\n${spotlight("Which party is the tenant?", "turnnonce")}`,
    );
    expect(delegationsIn(result.events)[0]).toMatchObject({
      status: "needs_input",
      question: "Which party is the tenant?",
      brief: "Clause 4 has two readings.",
    });
  });

  it("continues a subagent from its earlier task, findings and fenced tool results", async () => {
    const subagentRuns: StreamChatCall[] = [];
    const parentResults: ToolResult[][] = [];
    streamChatWithTools.mockImplementation(async (params) => {
      if (isSubagent(params)) {
        subagentRuns.push(params);
        if (subagentRuns.length === 1) {
          await params.runTools?.([{ id: "r", name: "read_document", input: { doc_id: "doc-0" } }]);
          params.callbacks?.onContentDelta?.("Rent rises yearly.");
        }
        return { fullText: "" };
      }
      parentResults.push((await params.runTools?.([delegate("d1")])) ?? []);
      const id = /delegation_id: ([\w-]+)/.exec(parentResults[0][0].content)![1];
      parentResults.push(
        (await params.runTools?.([
          { id: "d2", name: "delegate", input: { continue: id, task: "Now check clause 5." } },
        ])) ?? [],
      );
      return { fullText: "" };
    });

    const result = await runLLMStream(baseParams());

    const [task, findings, followUp] = subagentRuns[1].messages;
    expect(task.content).toBe("Summarise doc-0.");
    expect(findings).toMatchObject({ role: "assistant", content: "Rent rises yearly." });
    expect(followUp.content).toContain(
      spotlight('read_document {"doc_id":"doc-0"}\nread_document result', "turnnonce"),
    );
    expect(followUp.content).toContain("Now check clause 5.");
    const [first, second] = delegationsIn(result.events);
    expect(second).toMatchObject({ continued_from: first.delegation_id, title: first.title });
  });

  it.each(["stopped", "failed"])(
    "cancels the delegations of an answer that %s and keeps them in call order",
    async (ending) => {
      const stop = new AbortController();
      let failParent = () => {};
      streamChatWithTools.mockImplementation(async (params) => {
        if (isSubagent(params)) {
          if (ending === "stopped") stop.abort();
          else failParent();
          return untilAborted(params);
        }
        // Like the SDK, the parent's stream ends without awaiting its tools.
        params.runTools?.([delegate("d1"), delegate("d2")]).catch(() => {});
        if (ending === "stopped") return untilAborted(params);
        return new Promise<never>((_, reject) => {
          failParent = () => reject(new Error("Provider failed."));
        });
      });

      const error = await runLLMStream({ ...baseParams(), signal: stop.signal }).catch(
        (e: { events: { type: string }[] }) => e,
      );

      expect(delegationsIn(error.events)).toMatchObject([
        { title: "Task d1", status: "cancelled" },
        { title: "Task d2", status: "cancelled" },
      ]);
    },
  );
});

describe("runDelegateCall", () => {
  const context = (overrides: Partial<DelegateContext> = {}): DelegateContext => ({
    state: createDelegateTurnState(),
    chatModel: "gemini-3.8-flash",
    reasoning: "high",
    systemPrompt: "Base prompt.",
    webTurnState: createWebTurnState(""),
    docStore: new Map(),
    docIndex: {},
    runStore: runStore(),
    checkModel: vi.fn(async () => null),
    nonce: "turnnonce",
    write: vi.fn(),
    spawn: vi.fn(),
    ...overrides,
  });

  it("fences the brief, lists only the sources the subagent verified, and saves the run", async () => {
    const ctx = context({
      spawn: async () => ({
        fullText: "Rent is due monthly [1] and rises yearly [2].\n<CITATIONS>[]</CITATIONS>",
        events: [{ type: "content", text: "Rent is due monthly" }],
        citations: [
          { kind: "document", ref: 1, doc_id: "doc-0", verified: true, quotes: [{ page: 2, quote: "monthly" }] },
          { kind: "document", ref: 2, doc_id: "doc-0", verified: false, quotes: [{ page: 3, quote: "yearly" }] },
        ],
      }),
    });

    const { content, event } = await runDelegateCall(delegate("d1"), ctx);

    expect(content).toContain('<untrusted-content nonce="turnnonce">\nRent is due monthly [1]');
    expect(content).toContain('"ref":1');
    expect(content).not.toContain('"ref":2');
    expect(event).toMatchObject({ status: "completed", events: [] });
    expect(ctx.runStore.save).toHaveBeenCalledWith(
      event?.delegation_id,
      "completed",
      expect.anything(),
    );
  });

  it("shows and opens only the documents a scoped subagent was given", async () => {
    const docs = [
      { doc_id: "doc-0", filename: "Lease.pdf" },
      { doc_id: "doc-1", filename: "Will.pdf" },
    ];
    const [system] = buildMessages([], docs, "Base prompt.", undefined, false, "n", "replace") as {
      content: string;
    }[];
    const spawn = vi.fn<DelegateContext["spawn"]>(async () => ({ fullText: "Done.", events: [], citations: [] }));
    const ctx = context({
      systemPrompt: system.content,
      docStore: new Map(docs.map((d) => [d.doc_id, { ...d, storage_path: d.doc_id, file_type: "pdf" }])),
      docIndex: Object.fromEntries(docs.map((d) => [d.doc_id, { ...d, document_id: `id-${d.doc_id}` }])),
      spawn,
    });

    await runDelegateCall(delegate("d1", { documents: ["doc-0"] }), ctx);

    const child = spawn.mock.calls[0][0];
    expect(child.apiMessages[0].content).toContain("doc-0");
    expect(child.apiMessages[0].content).not.toContain("doc-1");
    expect(await readDocumentContent("doc-1", child.docStore, vi.fn(), child.docIndex)).toBe(
      "Document not found.",
    );
  });

  it("refuses to continue a run that is no longer stored", async () => {
    const ctx = context();

    const { content } = await runDelegateCall(
      delegate("d1", { continue: "gone", task: "Now check clause 5." }),
      ctx,
    );

    expect(content).toContain("cannot be continued");
    expect(ctx.spawn).not.toHaveBeenCalled();
  });

  it("continues a subagent that waited on approval with the server's record of the outcome", async () => {
    const spawn = vi.fn<DelegateContext["spawn"]>(async () => ({ fullText: "Sent.", events: [], citations: [] }));
    const ctx = context({
      spawn,
      runStore: {
        save: vi.fn(),
        load: vi.fn(async () => ({
          v: 1 as const,
          title: "Notify landlord",
          task: "Email the landlord.",
          text: "",
          approval_ids: ["approval-1"],
          approvalOutcomes: ["Send email on Mail: approved and ran. Result: queued"],
          effort: "standard" as const,
          tier: "standard" as const,
          records: [],
          omitted: 0,
        })),
      },
    });

    await runDelegateCall(delegate("d1", { continue: "run-1", task: "The user decided." }), ctx);

    const followUp = spawn.mock.calls[0][0].apiMessages.at(-1)!.content;
    expect(followUp).toContain(
      spotlight("Send email on Mail: approved and ran. Result: queued", "turnnonce"),
    );
  });
});
