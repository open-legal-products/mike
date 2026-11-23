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

import { runLLMStream } from "../streaming";
import { MAX_PARSED_CITATIONS } from "../citations";
import { runToolCalls } from "../tools/toolDispatcher";
import { emptyToolCallBatchResult } from "../tools/toolBatchResult";

describe("runLLMStream citation streaming", () => {
  it("parses each streamed citation once and replays only the newest snapshot", async () => {
    const count = 60;
    const block =
      "<CITATIONS>[" +
      Array.from(
        { length: count },
        (_, i) => JSON.stringify({ ref: i + 1, doc_id: "doc-0", page: 1, quote: `quote ${i}` }),
      ).join(",") +
      "]</CITATIONS>";
    const text = `Answer.\n${block}`;
    streamChatWithTools.mockImplementation(async (params: {
      callbacks?: { onContentDelta?: (delta: string) => void };
    }) => {
      // A provider streams small deltas; 8 characters keeps the test fast
      // while every citation still spans several of them.
      for (let i = 0; i < text.length; i += 8) {
        params.callbacks?.onContentDelta?.(text.slice(i, i + 8));
      }
      return { fullText: text };
    });
    const frames: { line: string; replay?: () => boolean }[] = [];
    const parse = vi.spyOn(JSON, "parse");
    let citationParses = 0;
    try {
      await runLLMStream({
        model: "gemini-3.8-flash",
        apiMessages: [
          { role: "system", content: "Base prompt." },
          { role: "user", content: "Cite the lease." },
        ],
        docStore: new Map(),
        docIndex: {},
        userId: "u1",
        db: {} as never,
        write: (line: string, opts?: { replay?: () => boolean }) =>
          void frames.push({ line, replay: opts?.replay }),
        nonce: "turnnonce",
      } as Parameters<typeof runLLMStream>[0]);
      citationParses = parse.mock.calls.filter(([raw]) =>
        typeof raw === "string" && raw.startsWith('{"ref":'),
      ).length;
    } finally {
      parse.mockRestore();
    }
    // Rescanning the whole buffer per delta parses each citation once per
    // later delta: thousands of parses for 60 citations. Streaming stops at
    // the citation cap, so the citations past it are never parsed.
    const streamed = Math.min(count, MAX_PARSED_CITATIONS);
    expect(citationParses).toBe(streamed);

    const citationFrames = frames.filter((f) => f.line.includes('"type":"citations"'));
    expect(citationFrames).toHaveLength(streamed + 2); // started, one per citation, final
    // What a client attaching after the answer would be replayed.
    const replayed = citationFrames.filter((f) => f.replay?.() ?? true);
    expect(replayed.map((f) => JSON.parse(f.line.slice(6)).status)).toEqual(["final"]);
  });

  it("records cite_sources before the answer and merges a stray block's other refs", async () => {
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
      const text =
        "Either party may terminate [1]; rent is paid monthly [2]." +
        '<CITATIONS>[{"ref": 1, "doc_id": "doc-0", "page": 1, "quote": "overridden"},' +
        '{"ref": 2, "doc_id": "doc-0", "page": 1, "quote": "The Tenant shall pay rent monthly in advance"}]</CITATIONS>';
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
      citeSources: true,
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
    // The block is hidden, and fills only the ref no call recorded.
    expect(frames.join("")).not.toContain("CITATIONS");
    const final = citationFrames.at(-1)!;
    expect(final.status).toBe("final");
    expect(final.citations).toMatchObject([
      { ref: 1, quote: "Either party may terminate on 30 days' written notice", verified: true },
      { ref: 2, quote: "The Tenant shall pay rent monthly in advance", verified: true },
    ]);
    expect(result.citations).toEqual(final.citations);
  });

  it("does not offer cite_sources unless the caller's prompt asks for it", async () => {
    let toolNames: string[] = [];
    streamChatWithTools.mockImplementation(async (params: { tools: { function: { name: string } }[] }) => {
      toolNames = params.tools.map((t) => t.function.name);
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
    await runLLMStream(base as Parameters<typeof runLLMStream>[0]);
    expect(toolNames).not.toContain("cite_sources");
    // A custom citation builder (tabular) reads its own block.
    await runLLMStream({ ...base, citeSources: true, buildCitations: () => [] } as Parameters<typeof runLLMStream>[0]);
    expect(toolNames).not.toContain("cite_sources");
  });
});
