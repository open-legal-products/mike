import { beforeEach, expect, it, vi } from "vitest";
import type { StreamChatParams } from "../../../../lib/llm/types";

const { streamChatWithTools } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatParams) => ({ fullText: "" })),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatParams) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));
vi.mock("../../../../lib/integrations/googleDrive", async (original) => ({
  ...(await original<typeof import("../../../../lib/integrations/googleDrive")>()),
  buildGoogleDriveTools: async () => [],
}));
vi.mock("../../../../lib/integrations/googleWorkspace", async (original) => ({
  ...(await original<typeof import("../../../../lib/integrations/googleWorkspace")>()),
  buildGoogleWorkspaceTools: async () => [],
}));
vi.mock("../../../../lib/documentVersions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/documentVersions")>()),
  loadActiveVersion: async () => ({
    id: "version-1", version_number: 1, storage_path: "synthetic/agreement.txt",
  }),
}));

vi.mock("../../../../lib/documentTextCache", async (original) => ({
  ...(await original<typeof import("../../../../lib/documentTextCache")>()),
  loadVersionTextState: async () => ({ text: "[Page 1]\n\n[Page 2]\nRent is due.\nRent is due.", textlessPageCount: 0 }),
}));

import { runLLMStream } from "../streaming";

beforeEach(() => vi.clearAllMocks());

it.each(["completed", "stopped"] as const)(
  "delivers the selected occurrence on a %s turn without a citation tool call",
  async (end) => {
    const controller = new AbortController();
    streamChatWithTools.mockImplementationOnce(async ({ callbacks, runTools }) => {
      const [read] = await runTools!([
        { id: "read", name: "read_document", input: { doc_id: "doc-0" } },
      ]);
      expect(read.content).toContain("Rent is due.");
      const handles = [...read.content.matchAll(/(\[\[p[0-9a-f]{8}:\d+\]\]) Rent is due/g)];
      // On #931 the provider can emit a numeric marker after this same read,
      // even when it has omitted cite_sources. That leaves the marker dangling.
      const marker = handles[1]?.[1] ?? "[1]";
      callbacks?.onContentDelta?.("Rent is due ");
      for (const char of marker) callbacks?.onContentDelta?.(char);
      if (end === "stopped") {
        controller.abort();
        throw new Error("synthetic stop");
      }
      return { fullText: "Rent is due " + marker };
    });

    const frames: { type: string; status?: string; text?: string }[] = [];
    const run = runLLMStream({
      apiMessages: [{ role: "user", content: "When is rent due?" }],
      userId: "u1",
      db: {} as never,
      model: "gemini-3.8-flash",
      signal: controller.signal,
      docStore: new Map([["doc-0", {
        filename: "Lease.pdf", file_type: "pdf", storage_path: "original",
      }]]),
      docIndex: { "doc-0": { document_id: "doc", filename: "Lease.pdf", version_id: "old" } },
      write: line => {
        if (line.startsWith("data: {")) frames.push(JSON.parse(line.slice(6)));
      },
    });
    const expected = {
      fullText: "Rent is due [1]",
      citations: [{
        ref: 1, version_id: "version-1", page: 2, quote: "Rent is due.", verified: true,
        quotes: [{ verification: { start_char: 32, end_char: 44, pdf_text_offset: 9 } }],
      }],
    };
    if (end === "stopped") await expect(run).rejects.toMatchObject(expected);
    else await expect(run).resolves.toMatchObject(expected);
    const citationFrame = frames.findIndex(frame => frame.type === "citations" && frame.status === "partial");
    const markerFrame = frames.findIndex(frame => frame.text === "[1]");
    expect(citationFrame).toBeGreaterThanOrEqual(0);
    expect(markerFrame).toBeGreaterThan(citationFrame);
  },
);
