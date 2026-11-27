import { describe, expect, it, vi } from "vitest";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: unknown) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: async () => [] }));
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls: vi.fn() }));
vi.mock("../../../../lib/integrations/googleDrive", () => ({ buildGoogleDriveTools: async () => [] }));
vi.mock("../../../../lib/integrations/googleWorkspace", () => ({ buildGoogleWorkspaceTools: async () => [] }));

import type { StreamChatParams } from "../../../../lib/llm/types";
import { runLLMStream } from "../streaming";
import { runToolCalls } from "../tools/toolDispatcher";
import { emptyToolCallBatchResult } from "../tools/toolBatchResult";

describe("runLLMStream citation streaming", () => {
  it("records cite_sources before the answer and keeps only what it recorded", async () => {
    const source =
      "[Page 1]\nThe Tenant shall pay rent monthly in advance.\n[Page 2]\nEither party may terminate on 30 days' written notice.";
    // The rest of the batch (none here) goes to the dispatcher.
    vi.mocked(runToolCalls).mockResolvedValue(emptyToolCallBatchResult());
    let toolNames: string[] = [];
    let toolResult = "";
    streamChatWithTools.mockImplementation(async (params: {
      tools: { function: { name: string } }[];
      callbacks?: { onContentDelta?: (delta: string) => void };
      runTools: (
        calls: { id: string; name: string; input: Record<string, unknown> }[],
      ) => Promise<{ tool_use_id: string; content: string }[]>;
    }) => {
      toolNames = params.tools.map((t) => t.function.name);
      const [result] = await params.runTools([
        {
          id: "cite",
          name: "cite_sources",
          input: {
            citations: [
              { ref: 1, doc_id: "doc-0", quotes: [{ page: "2", quote: "Either party may terminate on 30 days' written notice" }] },
            ],
          },
        },
      ]);
      toolResult = result.content;
      const text = "Either party may terminate [1].";
      params.callbacks?.onContentDelta?.(text);
      return { fullText: text };
    });
    const frames: string[] = [];
    const result = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "When can the lease end?" }],
      docStore: new Map([
        ["doc-0", { storage_path: "", file_type: "txt", filename: "Lease.txt", inline_text: source }],
      ]),
      // A request-scoped document: its text is read from the store, not the database.
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: (line: string) => void frames.push(line),
      nonce: "turnnonce",
    } as Parameters<typeof runLLMStream>[0]);

    expect(toolNames[0]).toBe("cite_sources");
    expect(JSON.parse(toolResult)).toMatchObject({ recorded_refs: [1] });
    const citationFrames = frames
      .filter((f) => f.includes('"type":"citations"'))
      .map((f) => JSON.parse(f.slice(6)));
    // The recorded citation reaches the client before any answer text.
    const firstContent = frames.findIndex((f) => f.includes('"type":"content_delta"'));
    const firstCitations = frames.findIndex((f) => f.includes('"type":"citations"'));
    expect(firstCitations).toBeLessThan(firstContent);
    expect(citationFrames[0]).toMatchObject({
      status: "partial",
      citations: [{ ref: 1, quote: "Either party may terminate on 30 days' written notice" }],
    });
    const final = citationFrames.at(-1)!;
    expect(final.status).toBe("final");
    expect(final.citations).toMatchObject([
      { ref: 1, quote: "Either party may terminate on 30 days' written notice", verified: true },
    ]);
    expect(result.citations).toEqual(final.citations);
    expect(result.events).toContainEqual({ type: "content", text: "Either party may terminate [1]." });
    // The call is a step of the stored turn, streamed before the answer.
    const step = {
      type: "citations_recorded",
      refs: [1],
      // An unpaginated text file is shown with the document icon.
      sources: [{ name: "Lease.txt", type: "pdf", ref: 1 }],
      quotes_not_found: 0,
      rejected: 0,
    };
    expect(result.events).toContainEqual(step);
    const startFrame = frames.indexOf(
      `data: ${JSON.stringify({ type: "citations_recorded_start" })}\n\n`,
    );
    const stepFrame = frames.indexOf(`data: ${JSON.stringify(step)}\n\n`);
    expect(startFrame).toBeGreaterThanOrEqual(0);
    expect(startFrame).toBeLessThan(stepFrame);
    expect(stepFrame).toBeLessThan(firstContent);
    // The start frame is a progress signal, not a step of the stored turn.
    expect(result.events.map((e) => e.type)).not.toContain("citations_recorded_start");
  });

  it("opens the citations step when the model starts writing cite_sources, once", async () => {
    vi.mocked(runToolCalls).mockResolvedValue(emptyToolCallBatchResult());
    const frames: string[] = [];
    const startFrame = `data: ${JSON.stringify({ type: "citations_recorded_start" })}\n\n`;
    const starts = () => frames.filter((f) => f === startFrame);
    let openedAtInputStart: string[] = [];
    streamChatWithTools.mockImplementation(async (params: StreamChatParams) => {
      const call = { id: "cite", name: "cite_sources", input: { citations: [] } };
      params.callbacks?.onContentDelta?.("Checking the lease.");
      // The arguments are still streaming: only the id and name are known.
      params.callbacks?.onToolInputStart?.({ id: call.id, name: call.name });
      openedAtInputStart = starts();
      params.callbacks?.onToolCallStart?.(call);
      await params.runTools?.([call]);
      return { fullText: "" };
    });
    const result = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "When can the lease end?" }],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: (line: string) => void frames.push(line),
      nonce: "turnnonce",
    } as Parameters<typeof runLLMStream>[0]);

    // The step itself opens while the quotes are written, not a placeholder.
    expect(openedAtInputStart).toEqual([startFrame]);
    expect(frames.some((f) => f.includes('"type":"tool_call_start"'))).toBe(false);
    // Neither the completed call nor running it opens the step a second time.
    expect(starts()).toEqual([startFrame]);
    // Text written before the call is a finished part of the turn by then.
    expect(result.events[0]).toEqual({ type: "content", text: "Checking the lease." });
    // The call's result completes the step it opened.
    expect(frames.indexOf(startFrame)).toBeLessThan(
      frames.findIndex((f) => f.includes('"type":"citations_recorded"')
        && !f.includes("citations_recorded_start")),
    );
  });

  it("announces any other tool with a placeholder when the model starts writing it", async () => {
    vi.mocked(runToolCalls).mockResolvedValue(emptyToolCallBatchResult());
    const frames: string[] = [];
    streamChatWithTools.mockImplementation(async (params: StreamChatParams) => {
      const call = { id: "read", name: "read_document", input: { doc_id: "doc-0" } };
      params.callbacks?.onToolInputStart?.({ id: call.id, name: call.name });
      params.callbacks?.onToolCallStart?.(call);
      await params.runTools?.([call]);
      return { fullText: "" };
    });
    await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Read the lease." }],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: (line: string) => void frames.push(line),
      nonce: "turnnonce",
    } as Parameters<typeof runLLMStream>[0]);

    expect(frames.filter((f) => f.includes('"type":"tool_call_start"'))).toEqual([
      `data: ${JSON.stringify({ type: "tool_call_start", name: "read_document" })}\n\n`,
    ]);
    expect(frames.some((f) => f.includes("citations_recorded_start"))).toBe(false);
  });

  it("checks same-batch citations after an edit updates the source", async () => {
    const before = "Only the landlord may extend the term.";
    const after = "Either party can request a mediation.";
    const doc = { storage_path: "", file_type: "txt", filename: "Lease.txt", inline_text: before };
    vi.mocked(runToolCalls).mockImplementationOnce(async (calls) => {
      expect(calls.map(call => call.function.name)).toEqual(["edit_document"]);
      doc.inline_text = after;
      return emptyToolCallBatchResult();
    });
    streamChatWithTools.mockImplementationOnce(async ({ runTools }: StreamChatParams) => {
      const results = await runTools!([
        { id: "edit", name: "edit_document", input: { doc_id: "doc-0" } },
        { id: "cite", name: "cite_sources", input: { citations: [
          { ref: 1, doc_id: "doc-0", quotes: [{ quote: before }] },
          { ref: 2, doc_id: "doc-0", quotes: [{ quote: after }] },
        ] } },
      ]);
      expect(results.map(result => result.tool_use_id)).toEqual(["edit", "cite"]);
      return { fullText: "" };
    });
    const result = await runLLMStream({
      model: "gemini-3.8-flash", apiMessages: [{ role: "user", content: "Update the lease." }],
      docStore: new Map([["doc-0", doc]]), docIndex: {}, userId: "u1", db: {} as never, write: () => {},
    });
    expect(result.citations).toMatchObject([
      { ref: 1, quote: before, verified: false },
      { ref: 2, quote: after, verified: true },
    ]);
  });

  it("offers cite_sources for documents, or for a tabular review's cells", async () => {
    const tools: { name: string; parameters: { properties: { citations: { items: { properties: object } } } } }[][] = [];
    streamChatWithTools.mockImplementation(async (params: {
      tools: { function: (typeof tools)[number][number] }[];
    }) => {
      tools.push(params.tools.map((t) => t.function));
      return { fullText: "" };
    });
    const base = {
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Hi" }],
      docStore: new Map(),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: () => {},
    };
    const entryFields = (run: number) =>
      Object.keys(
        tools[run].find((t) => t.name === "cite_sources")!.parameters.properties
          .citations.items.properties,
      );

    await runLLMStream(base as Parameters<typeof runLLMStream>[0]);
    expect(entryFields(0)).toEqual(["ref", "doc_id", "cluster_id", "quotes"]);

    await runLLMStream({
      ...base,
      citationSources: "tabular_cells",
      tabularStore: { columns: [], documents: [], cells: new Map() },
    } as Parameters<typeof runLLMStream>[0]);
    expect(entryFields(1)).toEqual(["ref", "col_index", "row_index", "quote"]);
  });

  it("replays only the newest partial citations to a client that attaches later", async () => {
    vi.mocked(runToolCalls).mockResolvedValue(emptyToolCallBatchResult());
    streamChatWithTools.mockImplementation(async (params: {
      runTools: (calls: { id: string; name: string; input: Record<string, unknown> }[]) => Promise<unknown>;
    }) => {
      for (const ref of [1, 2]) {
        await params.runTools([{
          id: `cite-${ref}`,
          name: "cite_sources",
          input: { citations: [{ ref, doc_id: "doc-0", quotes: [{ quote: "Rent is due monthly" }] }] },
        }]);
      }
      await params.runTools([{
        id: "withdraw", name: "cite_sources", input: { citations: [], drop_refs: [1, 2] },
      }]);
      return { fullText: "" };
    });
    const frames: { line: string; replay?: () => boolean }[] = [];
    const result = await runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "Rent?" }],
      docStore: new Map([
        ["doc-0", { storage_path: "", file_type: "txt", filename: "Lease.txt", inline_text: "Rent is due monthly." }],
      ]),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: (line: string, opts?: { replay?: () => boolean }) => void frames.push({ line, replay: opts?.replay }),
    } as Parameters<typeof runLLMStream>[0]);

    const citationFrames = frames.filter((f) => f.line.includes('"type":"citations"'));
    const snapshots = citationFrames.map(f => JSON.parse(f.line.slice(6)));
    expect(snapshots.map(f => f.status)).toEqual(["partial", "partial", "partial", "final"]);
    expect(snapshots.map(f => f.citations.map((row: { ref: number }) => row.ref))).toEqual([
      [1], [1, 2], [], [],
    ]);
    expect(result.citations).toEqual([]);
    expect(result.events).toContainEqual(expect.objectContaining({ removed_refs: [1, 2] }));
    const replayed = citationFrames.filter((f) => f.replay?.() ?? true);
    expect(replayed.map((f) => JSON.parse(f.line.slice(6)).status)).toEqual(["final"]);
  });
});

describe("runLLMStream unrecorded citation markers", () => {
  const source = "Either party may terminate on 30 days' written notice.";
  const citeCall = {
    id: "late-cite",
    name: "cite_sources",
    input: { citations: [{ ref: 1, doc_id: "doc-0", quotes: [{ quote: "Either party may terminate on 30 days' written notice" }] }] },
  };
  const run = (frames: string[] = []) =>
    runLLMStream({
      model: "gemini-3.8-flash",
      apiMessages: [{ role: "user", content: "When can the lease end?" }],
      docStore: new Map([
        ["doc-0", { storage_path: "", file_type: "txt", filename: "Lease.txt", inline_text: source }],
      ]),
      docIndex: {},
      userId: "u1",
      db: {} as never,
      write: (line: string) => void frames.push(line),
    } as Parameters<typeof runLLMStream>[0]);

  it("asks the model to record markers the finished answer left without a citation", async () => {
    vi.mocked(runToolCalls).mockResolvedValue(emptyToolCallBatchResult());
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    let followUp: ReturnType<NonNullable<StreamChatParams["followUp"]>> = null;
    streamChatWithTools.mockImplementationOnce(async (params: StreamChatParams) => {
      const text = "Either party may terminate [1].";
      params.callbacks?.onContentDelta?.(text);
      // What the adapter does when the model finishes: check, then run the
      // follow-up step's cite_sources call.
      followUp = params.followUp!(text);
      await params.runTools!([citeCall]);
      return { fullText: text };
    });
    const frames: string[] = [];

    const result = await run(frames);

    expect(followUp).toEqual({
      tool: "cite_sources",
      instruction: expect.stringContaining("Your answer uses [1], but no citation was recorded"),
    });
    const final = frames
      .filter((f) => f.includes('"type":"citations"'))
      .map((f) => JSON.parse(f.slice(6)))
      .at(-1);
    expect(final).toMatchObject({ status: "final", citations: [{ ref: 1, verified: true }] });
    expect(result.citations).toMatchObject([{ ref: 1, verified: true }]);
    expect(logged).toHaveBeenCalledWith(
      "[chat/citations] answer used markers without recorded citations",
      { unrecorded: 1, still_unrecorded: 0, sources: "documents" },
    );
    logged.mockRestore();
  });

  it("logs the markers a follow-up could not record", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    streamChatWithTools.mockImplementationOnce(async (params: StreamChatParams) => {
      const text = "Either party may terminate [1], with notice [2].";
      params.callbacks?.onContentDelta?.(text);
      params.followUp!(text);
      await params.runTools!([citeCall]);
      return { fullText: text };
    });

    await run();

    expect(logged).toHaveBeenCalledWith(
      "[chat/citations] answer used markers without recorded citations",
      { unrecorded: 2, still_unrecorded: 1, sources: "documents" },
    );
    logged.mockRestore();
  });

  it("asks for nothing when every marker has a recorded citation", async () => {
    vi.mocked(runToolCalls).mockResolvedValue(emptyToolCallBatchResult());
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    let followUp: unknown = "unchecked";
    streamChatWithTools.mockImplementationOnce(async (params: StreamChatParams) => {
      await params.runTools!([citeCall]);
      const text = "Either party may terminate [1].";
      params.callbacks?.onContentDelta?.(text);
      followUp = params.followUp!(text);
      return { fullText: text };
    });

    await run();

    expect(followUp).toBeNull();
    expect(logged).not.toHaveBeenCalledWith(
      "[chat/citations] answer used markers without recorded citations",
      expect.anything(),
    );
    logged.mockRestore();
  });
});
