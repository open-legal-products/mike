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
vi.mock("../tools/toolDispatcher", () => ({ runToolCalls: vi.fn() }));
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
};

const NOTICE = "\n\n_Stopped early: this response reached the model's output limit. Asking for one part at a time will get the rest._";
const SOURCE = "Written acceptance is required.";
const CITATION = { ref: 1, doc_id: "doc-0", page: 1, quote: SOURCE };

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

function replay(modelText: string, notice = NOTICE) {
  streamChatWithTools.mockImplementationOnce(async ({ callbacks }) => {
    callbacks?.onContentDelta?.(modelText);
    if (notice) {
      if (callbacks?.onStopNotice) callbacks.onStopNotice(notice);
      else callbacks?.onContentDelta?.(notice);
    }
    return { fullText: modelText + notice };
  });
}

beforeEach(() => vi.clearAllMocks());

describe("server stop notices outside model citations", () => {
  it.each([
    ["missing closing tag", `Answer [1] [2].\n<CITATIONS>[${JSON.stringify(CITATION)},{"ref":2,"doc_id":"doc-0","quote":"cut`],
    ["malformed JSON", "Answer [1].\n<CITATIONS>[{not json]</CITATIONS>"],
    ["missing citation fields", 'Answer [1].\n<CITATIONS>[{"ref":1}]</CITATIONS>'],
  ])("keeps the output-limit notice visible and saved after %s, without trusting partial citations", async (_, text) => {
    replay(text);
    const params = baseParams();

    const result = await runLLMStream(params);
    const visible = result.events.flatMap((event) => event.type === "content" ? [event.text] : []).join("");
    const streamed = params.write.mock.calls.map(([chunk]) => chunk).filter((chunk) => chunk.startsWith("data: {")).map((chunk) => JSON.parse(chunk.slice(6)) as { type: string; text?: string });

    expect(visible).toContain(NOTICE);
    expect(visible).not.toContain("<CITATIONS>");
    expect(visible).not.toContain('"doc_id"');
    expect(streamed.filter((frame) => frame.type === "content_delta").map((frame) => frame.text ?? "").join("")).toBe(visible);
    expect(result.citations).toEqual([]);
    expect(result.fullText).toBe(text + NOTICE);
  });

  it("keeps normal answers unchanged", async () => {
    replay(`Answer [1].\n<CITATIONS>${JSON.stringify([CITATION])}</CITATIONS>`, "");
    const result = await runLLMStream(baseParams());
    expect(result.events.filter((event) => event.type === "content")).toEqual([{ type: "content", text: "Answer [1].\n" }]);
    expect(result.citations).toMatchObject([{ ref: 1, verified: true, version_id: "version-1" }]);
  });

  it("does not promote an unverified citation when surfacing a notice", async () => {
    replay(`Answer [1].\n<CITATIONS>${JSON.stringify([{ ...CITATION, quote: "Not in the source." }])}</CITATIONS>`);
    const result = await runLLMStream(baseParams());
    expect(result.citations).toMatchObject([{ ref: 1, verified: false }]);
    expect(result.events).toContainEqual({ type: "content", text: NOTICE });
  });
});
