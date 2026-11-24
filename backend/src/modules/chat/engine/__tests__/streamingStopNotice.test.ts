import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamCallbacks } from "../../../../lib/llm/types";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: vi.fn(async () =>
    (await import("../tools/toolBatchResult.js")).emptyToolCallBatchResult(),
  ),
}));
vi.mock("../../../../lib/integrations/googleDrive", () => ({ buildGoogleDriveTools: async () => [] }));
vi.mock("../../../../lib/integrations/googleWorkspace", () => ({ buildGoogleWorkspaceTools: async () => [] }));
vi.mock("../../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion: async () => ({
    id: "version-1", version_number: 1, storage_path: "synthetic/agreement.txt",
  }),
}));

import { runLLMStream } from "../streaming";

type StreamChatCall = {
  callbacks?: StreamCallbacks & { onStopNotice?: (notice: string) => void };
  runTools?: (calls: { id: string; name: string; input: Record<string, unknown> }[]) => Promise<unknown>;
};

const NOTICE = "\n\n_Stopped early: this response reached the model's output limit. Asking for one part at a time will get the rest._";
const SOURCE = "Written acceptance is required.";
const CITATION = { ref: 1, doc_id: "doc-0", quotes: [{ page: "1", quote: SOURCE }] };

function baseParams() {
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user" as const, content: "Review this document." }],
    docStore: new Map([["doc-0", {
      filename: "Agreement.txt", file_type: "txt", storage_path: "synthetic/agreement.txt",
      inline_text: SOURCE,
    }]]),
    docIndex: { "doc-0": {
      filename: "Agreement.txt", document_id: "document-1", version_id: "version-1", version_number: 1,
    } },
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
  };
}

/** The model records `citations` (if any), writes `modelText`, and is cut off. */
function replay(modelText: string, notice = NOTICE, citations: unknown[] = []) {
  streamChatWithTools.mockImplementationOnce(async ({ callbacks, runTools }) => {
    if (citations.length) {
      await runTools?.([{ id: "cite", name: "cite_sources", input: { citations } }]);
    }
    callbacks?.onContentDelta?.(modelText);
    if (notice) {
      if (callbacks?.onStopNotice) callbacks.onStopNotice(notice);
      else callbacks?.onContentDelta?.(notice);
    }
    return { fullText: modelText + notice };
  });
}

beforeEach(() => vi.clearAllMocks());

describe("server stop notices", () => {
  it("keeps the output-limit notice visible and saved as its own part of the answer", async () => {
    replay("Answer [1] that was cut", NOTICE, [CITATION]);
    const params = baseParams();

    const result = await runLLMStream(params);
    const content = result.events.flatMap((event) => event.type === "content" ? [event.text] : []);
    const streamed = params.write.mock.calls.map(([chunk]) => chunk).filter((chunk) => chunk.startsWith("data: {")).map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; text?: string });

    expect(content).toEqual(["Answer [1] that was cut", NOTICE]);
    expect(streamed.filter((frame) => frame.type === "content_delta").map((frame) => frame.text ?? "").join("")).toBe(content.join(""));
    expect(result.fullText).toBe("Answer [1] that was cut" + NOTICE);
  });

  it("keeps the citations recorded before the answer was cut", async () => {
    replay("Answer [1] that was cut", NOTICE, [CITATION]);
    const result = await runLLMStream(baseParams());
    expect(result.citations).toMatchObject([{ ref: 1, verified: true, version_id: "version-1" }]);
  });

  it("does not promote an unverified citation when surfacing a notice", async () => {
    replay("Answer [1].", NOTICE, [{ ...CITATION, quotes: [{ quote: "Not in the source." }] }]);
    const result = await runLLMStream(baseParams());
    expect(result.citations).toMatchObject([{ ref: 1, verified: false }]);
    expect(result.events).toContainEqual({ type: "content", text: NOTICE });
  });
});
