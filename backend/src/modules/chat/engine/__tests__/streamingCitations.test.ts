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
    // later delta: thousands of parses for 60 citations.
    expect(citationParses).toBe(count);

    const citationFrames = frames.filter((f) => f.line.includes('"type":"citations"'));
    expect(citationFrames).toHaveLength(count + 2); // started, one per citation, final
    // What a client attaching after the answer would be replayed.
    const replayed = citationFrames.filter((f) => f.replay?.() ?? true);
    expect(replayed.map((f) => JSON.parse(f.line.slice(6)).status)).toEqual(["final"]);
  });
});
