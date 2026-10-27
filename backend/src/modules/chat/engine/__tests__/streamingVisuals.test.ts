import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../../../lib/supabase";

const { streamChatWithTools, uploadFile } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({ fullText: "" })),
  uploadFile: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));
vi.mock("../../../../lib/mcpConnectors", () => ({ buildUserMcpTools: vi.fn(async () => []) }));
vi.mock("../../../../lib/sandbox", () => ({ getSandbox: () => ({ render: async () => ({ ok: true, errors: [] }) }) }));
vi.mock("../../../../lib/storage", () => ({
  downloadFile: vi.fn(),
  generatedDocKey: (userId: string, docId: string, filename: string) => `generated/${userId}/${docId}/${filename}`,
  uploadFile,
  extractedTextKey: (id: string) => `extracted-text/${id}.txt`,
}));
vi.mock("../../../../lib/downloadTokens", () => ({ buildDownloadUrl: () => "/download/test-token" }));
vi.mock("../../../documents/documents.service", () => ({
  applyTrackedEditsToDocument: vi.fn(),
  createDocumentVersion: vi.fn(async () => ({ data: { id: "version-1", version_number: 1 }, error: null })),
  loadCurrentVersionBytes: vi.fn(),
  readStoredDocumentText: vi.fn(),
  saveVisualVersion: vi.fn(),
}));

import { createKeyedLock } from "../tools/documentLocks";
import { runLLMStream } from "../streaming";

type ToolResult = { tool_use_id: string; content: string };
type StreamChatCall = {
  systemPrompt: string;
  tools: { function: { name: string } }[];
  callbacks?: { onContentDelta?: (text: string) => void };
  runTools?: (calls: { id: string; name: string; input: Record<string, unknown> }[]) => Promise<ToolResult[]>;
  [key: string]: unknown;
};

/** Every query chain ends in a saved row; the visual build only inserts the documents row. */
function fakeDb() {
  const query: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      if (prop === "then") return undefined;
      if (prop === "single" || prop === "maybeSingle") return async () => ({ data: { id: "doc-uuid" }, error: null });
      return () => query;
    },
  });
  return { from: () => query } as unknown as Db;
}

function baseParams() {
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user", content: "Who owns what?" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
  };
}

const lastCall = () => streamChatWithTools.mock.calls[0]![0];
const names = () => lastCall().tools.map((t) => t.function.name);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runLLMStream visuals", () => {
  it("withholds the tools and the prompt from read-only callers and subagents", async () => {
    await runLLMStream({ ...baseParams(), allowDocumentMutation: false });
    expect(names()).not.toContain("generate_visual");
    expect(lastCall().systemPrompt).not.toContain("VISUALS:");

    streamChatWithTools.mockClear();
    await runLLMStream({
      ...baseParams(),
      subagentRun: {
        connectorTools: [],
        webTurnState: { readable: new Set(), pages: new Map(), budgets: [], subagentBudget: { limits: { searches: 0, reads: 0 }, used: { searches: 0, reads: 0 } } },
        pythonTurnState: { budgets: [], results: new Map(), stored: { bytes: 0 } },
        courtlistenerTurnState: { casesByClusterId: new Map() },
        turnEditState: new Map(),
        documentLocks: createKeyedLock(),
        documentsScoped: false,
        onToolStart: vi.fn(),
        onUsage: vi.fn(),
        onToolBatch: vi.fn(),
      },
    });
    expect(names()).not.toContain("generate_visual");
    expect(names()).not.toContain("edit_visual");
    expect(lastCall().systemPrompt).not.toContain("VISUALS:");
  });

  it("offers run_python, its prompt and the visual data argument only with code analysis", async () => {
    await runLLMStream(baseParams());
    expect(names()).toEqual(expect.arrayContaining(["generate_visual", "edit_visual"]));
    expect(lastCall().systemPrompt).toContain("VISUALS:");
    expect(names()).not.toContain("run_python");
    expect(lastCall().systemPrompt).not.toContain("CODE ANALYSIS:");
    const generateProperties = () =>
      (lastCall().tools.find((t) => t.function.name === "generate_visual") as unknown as {
        function: { parameters: { properties: Record<string, unknown> } };
      }).function.parameters.properties;
    expect(generateProperties().data).toBeUndefined();

    streamChatWithTools.mockClear();
    await runLLMStream({ ...baseParams(), codeAnalysis: true });
    expect(names()).toContain("run_python");
    expect(lastCall().systemPrompt).toContain("CODE ANALYSIS:");
    expect(generateProperties().data).toBeDefined();
  });

  it("briefs a builder subagent that writes and saves the page, and hands the answer the document and the report", async () => {
    const params = {
      ...baseParams(),
      db: fakeDb(),
      docStore: new Map([["doc-1", { storage_path: "documents/u1/x/lease.pdf", file_type: "pdf", filename: "Lease.pdf" }]]),
      docIndex: { "doc-1": { document_id: "6f2a4d8e9b1c4e0a8f3b2c1d5e6f7a8b", filename: "Lease.pdf", version_id: null, version_number: 1 } },
    };
    let builderTools: string[] = [];
    let saveResult = "";
    let parentResults: ToolResult[] = [];
    streamChatWithTools.mockImplementation(async (call) => {
      if (call.systemPrompt.includes("VISUAL BUILDER:")) {
        builderTools = call.tools.map((t) => t.function.name);
        const [saved] = await call.runTools!([
          {
            id: "s1",
            name: "save_visual",
            input: { html: `<main class="mv-page"><h1 class="mv-title">Lease dates</h1><p data-cite="doc-1" data-page="3">Signed</p></main>`, summary: "Key dates" },
          },
        ]);
        saveResult = saved.content;
        call.callbacks?.onContentDelta?.("Drew a timeline of the lease dates.");
        return { fullText: "Drew a timeline of the lease dates." };
      }
      parentResults = await call.runTools!([
        { id: "g1", name: "generate_visual", input: { kind: "timeline", title: "Lease dates", brief: "Show the key dates in doc-1 as at 1 October 2026." } },
      ]);
      return { fullText: "Done." };
    });

    const result = await runLLMStream(params);

    expect(builderTools).toEqual(expect.arrayContaining(["read_document", "find_in_document", "save_visual"]));
    expect(builderTools).not.toContain("edit_document");
    expect(builderTools).not.toContain("generate_visual");
    expect(JSON.parse(saveResult)).toMatchObject({ ok: true, saved: true });
    const content = JSON.parse(parentResults[0].content);
    expect(content).toMatchObject({ document_id: "doc-uuid", doc_id: expect.any(String), report: expect.stringContaining("Drew a timeline") });
    expect(content.html).toBeUndefined();
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "delegation", kind: "visual", title: "Lease dates", status: "completed", brief: "Drew a timeline of the lease dates." }),
    );
    expect(result.events).toContainEqual(expect.objectContaining({ type: "doc_created", filename: "Lease dates.html", document_id: "doc-uuid" }));
    expect(params.write.mock.calls.flat().join("")).toContain('"delegation_start"');
    expect(uploadFile).toHaveBeenCalledTimes(1);
  });
});
