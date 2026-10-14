import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocIndex, DocStore } from "../types";
import type { Db } from "../../../../lib/supabase";

// Only external transport and persistence are faked. Planning, account binding,
// extraction, dispatch, inline reads, citation construction and verification run.
type StreamParams = Parameters<typeof import("../../../../lib/llm").streamChatWithTools>[0];
const mocks = vi.hoisted(() => ({ callTool: vi.fn(), connect: vi.fn(), stream: vi.fn<(params: StreamParams) => Promise<{ fullText: string }>>() }));
vi.mock("../../../../lib/llm", async (original) => ({
  ...(await original<typeof import("../../../../lib/llm")>()),
  streamChatWithTools: mocks.stream,
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class { connect = mocks.connect; callTool = mocks.callTool; close = async () => {}; },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {},
}));
vi.mock("../../../../lib/mcp/client", async (original) => ({
  ...(await original<typeof import("../../../../lib/mcp/client")>()),
  validateRemoteMcpUrl: async (url: string) => url,
}));
vi.mock("../../../../lib/mcp/oauth", async (original) => ({
  ...(await original<typeof import("../../../../lib/mcp/oauth")>()),
  discoverOAuthMetadata: async () => { throw new Error("not OAuth"); },
}));
import { executeApprovedMcpToolCall, executeMcpToolCall, planMcpToolCall } from "../../../../lib/mcp/servers";
import { runToolCalls } from "../tools/toolDispatcher";
import { runApprovedConnectorActions } from "../tools/connectorApprovals";
import { createCitation, parseCitations } from "../citations";
import { readDocumentContent } from "../tools/documentOps";
import { verifyCitations } from "../verifyCitations";
import { runLLMStream } from "../streaming";
import { extractCitations } from "../contextBuilders";

const args = { source: "legifrance", source_id: "JORFTEXT0001" };
const payload = {
  ...args, data_type: "legislation", title: "Article 1103",
  text: "Les contrats légalement formés tiennent lieu de loi à ceux qui les ont faits.",
  text_truncated: false, url: "https://www.legifrance.gouv.fr/codes/article/1",
};
function fixture() {
  const connector = {
    id: "c1", user_id: "u1", name: "Legal Data Hunter",
    server_url: "https://legaldatahunter.com/mcp", auth_type: "none",
    enabled: true, read_only: true, require_write_approval: true,
    encrypted_auth_config: null, auth_config_iv: null, auth_config_tag: null,
  };
  const tool = {
    id: "t1", connector_id: "c1", tool_name: "get_document",
    openai_tool_name: "mcp_c1_get_document", enabled: true,
    annotations: { readOnlyHint: true }, requires_confirmation: false,
  };
  const token = { grant_id: "grant-1" };
  const row = { id: "a1", role: "assistant", content: [] as unknown[], author_user_id: "u1" };
  const writes: { table: string; value: unknown }[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        select: () => chain,
        eq: (name: string, value: unknown) => { filters[name] = value; return chain; },
        single: async () => ({ data: tool.enabled && connector.enabled && filters["user_mcp_connectors.user_id"] === connector.user_id ? { ...tool, user_mcp_connectors: { ...connector } } : null, error: null }),
        maybeSingle: async () => ({ data: table === "chat_messages" ? row : { ...token }, error: null }),
        insert: async (value: unknown) => { writes.push({ table, value }); return { error: null }; },
      };
      return chain;
    },
    rpc: async (_name: string, params: { p_events: unknown[] }) => {
      row.content.push(...params.p_events);
      return { data: "appended", error: null };
    },
  } as unknown as Db;
  const docIndex: DocIndex = { "doc-0": { document_id: "existing", filename: "existing.pdf" } };
  const docStore: DocStore = new Map([["doc-1", { filename: "inline.txt", storage_path: "", file_type: "text/plain", inline_text: "unrelated" }]]);
  const dispatch = (approvals = false, userId = "u1") => runToolCalls(
    [{ id: "call-1", function: { name: tool.openai_tool_name, arguments: JSON.stringify(args) } }],
    docStore, userId, db, () => {}, undefined, undefined, docIndex,
    undefined, undefined, undefined, undefined, undefined, undefined,
    { connectorApprovals: approvals },
  );
  return { connector, tool, token, row, writes, db, docIndex, docStore, dispatch };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockReset().mockResolvedValue(undefined);
  mocks.callTool.mockReset().mockResolvedValue({ structuredContent: payload });
  vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "test-only-legal-source-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("MCP source → dispatcher → exact-quote citation", () => {
  it.each(["canonical-id", "title"])("cannot bypass strict verification or partial suppression using a source %s", async (alias) => {
    const f = fixture();
    await f.dispatch();
    const doc_id = alias === "title" ? payload.title : f.docIndex["doc-2"].document_id;
    const invalid = `<CITATIONS>${JSON.stringify([{ ref: 1, doc_id, quote: payload.text.toLowerCase() }])}</CITATIONS>`;
    expect(extractCitations(invalid, f.docIndex, f.docStore)).toEqual([]);
    const fullText = `<CITATIONS>${JSON.stringify([{ ref: 1, doc_id, quote: payload.text }])}</CITATIONS>`;
    mocks.stream.mockImplementationOnce(async (params) => {
      params.callbacks?.onContentDelta?.(fullText);
      return { fullText };
    });
    const chunks: string[] = [];
    const result = await runLLMStream({ model: "gemini-3.8-flash", apiMessages: [{ role: "user", content: "Find law" }], docIndex: f.docIndex, docStore: f.docStore, userId: "u1", db: f.db, write: (s) => chunks.push(s) });
    expect(result.citations).toMatchObject([{ doc_id: "doc-2", verified: true, document: { type: "legislation" } }]);
    for (const chunk of chunks.filter((s) => s.startsWith("data: {"))) {
      const event = JSON.parse(chunk.slice(6));
      if (event.type === "citations" && event.status === "partial") expect(event.citations).toEqual([]);
    }
  });
  it("suppresses unresolved external document identities", () => {
    expect(extractCitations('<CITATIONS>[{"ref":1,"doc_id":"mcp:unknown","quote":"invented"}]</CITATIONS>', {}, new Map())).toEqual([]);
  });
  it("never promotes a locally truncated MCP result", async () => {
    const f = fixture();
    mocks.callTool.mockResolvedValue({ structuredContent: { ...payload, text: "x".repeat(60_000) } });
    const result = await f.dispatch();
    expect((result.toolResults[0] as { content: string }).content).toContain("Truncated MCP result");
    expect(f.docStore.has("doc-2")).toBe(false);
  });
  it.each([
    payload.text.toLowerCase(), payload.text.replaceAll(" ", "  "),
    payload.text.replace(".", "!"), "Les contrats ... ceux qui les ont faits.",
    "Les contrats [[PAGE_BREAK]] ceux qui les ont faits.",
  ])("suppresses nonexact external quotes in fallback and final streams: %s", async (quote) => {
    const f = fixture();
    await f.dispatch();
    const fullText = `<CITATIONS>${JSON.stringify([{ ref: 1, doc_id: "doc-2", quote }])}</CITATIONS>`;
    expect(extractCitations(fullText, f.docIndex, f.docStore)).toEqual([]);
    mocks.stream.mockImplementationOnce(async (params) => {
      params.callbacks?.onContentDelta?.(fullText);
      return { fullText };
    });
    const chunks: string[] = [];
    const result = await runLLMStream({ model: "gemini-3.8-flash", apiMessages: [{ role: "user", content: "Find law" }], docIndex: f.docIndex, docStore: f.docStore, userId: "u1", db: f.db, write: (s) => chunks.push(s) });
    expect(result.citations).toEqual([]);
    for (const chunk of chunks.filter((s) => s.startsWith("data: {"))) {
      const event = JSON.parse(chunk.slice(6));
      if (event.type === "citations") expect(event.citations).toEqual([]);
    }
  });
  it("bounds partial and final streamed citations after real MCP dispatch and exact verification", async () => {
    const f = fixture();
    const text = payload.text + "\n" + "é".repeat(50_000);
    mocks.callTool.mockResolvedValue({ structuredContent: { ...payload, text } });
    mocks.stream.mockImplementationOnce(async (params) => {
      if (!params.runTools) throw new Error("runTools missing");
      const result = await params.runTools([{ id: "call-1", name: f.tool.openai_tool_name, input: args }]);
      expect(JSON.stringify(result)).toContain("doc-2");
      const fullText = `Answer [1].<CITATIONS>${JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ ref: i + 1, doc_id: "doc-2", quote: payload.text })))}</CITATIONS>`;
      params.callbacks?.onContentDelta?.(fullText);
      return { fullText };
    });
    const chunks: string[] = [];
    const result = await runLLMStream({ model: "gemini-3.8-flash", apiMessages: [{ role: "user", content: "Find the law" }], docIndex: f.docIndex, docStore: f.docStore, userId: "u1", db: f.db, write: (s) => chunks.push(s) });
    const snapshots = chunks.filter((s) => s.startsWith("data: {")).map((s) => JSON.parse(s.slice(6))).filter((event) => event.type === "citations" && event.citations.length);
    expect(snapshots.some((event) => event.status === "partial")).toBe(false);
    for (const event of snapshots) {
      expect(event.citations.length).toBeLessThanOrEqual(50);
      expect(Buffer.byteLength(JSON.stringify(event.citations))).toBeLessThanOrEqual(5_000_000);
    }
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]).toMatchObject({ verified: true, document: { type: "legislation", subdocuments: [{ text }], quotes: [{ verification: { verified: true } }] } });
  });

  it.each([["legislation", "legislation"], ["case_law", "case"], ["doctrine", "legal_research"]])("registers %s and verifies it as a document, not a CourtListener case", async (data_type, type) => {
    mocks.callTool.mockResolvedValue({ structuredContent: { ...payload, data_type } });
    const f = fixture();
    const result = await f.dispatch();
    expect(result.mcpEvents[0].status).toBe("ok");
    expect((result.toolResults[0] as { content: string }).content).toContain('"doc_id":"doc-2"');
    expect(f.docStore.get("doc-2")).toMatchObject({ inline_text: payload.text, panel_document: { type } });
    const source = f.docStore.get("doc-2")!;
    const parsed = parseCitations(`<CITATIONS>${JSON.stringify([
      { ref: 1, doc_id: "doc-2", quote: payload.text },
      { ref: 2, doc_id: "doc-2", quote: "This wholly invented proposition is not in the source." },
    ])}</CITATIONS>`);
    const caseReader = vi.fn();
    const citations = await verifyCitations(
      parsed.map((c) => createCitation(c, f.docIndex, undefined, f.docStore)),
      (id) => readDocumentContent(id, f.docStore, () => {}, f.docIndex, f.db, { emitEvents: false }),
      caseReader,
    );
    expect(citations[0]).toMatchObject({ kind: "document", verified: true, document: {
      ...source.panel_document,
      quotes: [{ quote: payload.text, target: { subdocument_id: `${f.docIndex["doc-2"].document_id}:text` }, verification: { verified: true } }],
    } });
    expect(citations.filter(Boolean)).toHaveLength(1);
    expect(caseReader).not.toHaveBeenCalled();
    await f.dispatch();
    expect(Object.keys(f.docIndex)).toEqual(["doc-0", "doc-2"]);
    expect(f.docStore.size).toBe(2);
    expect(f.writes.every((w) => w.table === "user_mcp_tool_audit_logs")).toBe(true);
  });

  it.each(["isError", "auth", "disabled", "other-user", "read-only", "identity", "type"])("never registers a source after %s failure", async (failure) => {
    const f = fixture();
    if (failure === "isError") mocks.callTool.mockResolvedValue({ isError: true, structuredContent: payload });
    if (failure === "auth") mocks.connect.mockRejectedValue(new Error("Unauthorized"));
    if (failure === "disabled") f.connector.enabled = false;
    if (failure === "read-only") { f.tool.annotations.readOnlyHint = false; f.tool.requires_confirmation = true; }
    if (failure === "identity") mocks.callTool.mockResolvedValue({ structuredContent: { ...payload, source_id: "wrong" } });
    if (failure === "type") mocks.callTool.mockResolvedValue({ structuredContent: { ...payload, data_type: "unknown" } });
    const result = await f.dispatch(false, failure === "other-user" ? "other" : "u1");
    expect(Object.keys(f.docIndex)).toEqual(["doc-0"]);
    expect(f.docStore.size).toBe(1);
    expect((result.toolResults[0] as { content: string }).content).not.toContain("Canonical legal source");
  });

  it("returns a source from the shared approved executor only after reviewed execution", async () => {
    const f = fixture();
    f.connector.read_only = false;
    f.tool.annotations.readOnlyHint = false;
    f.tool.requires_confirmation = true;
    const pending = await f.dispatch(true);
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(f.docStore.size).toBe(1);
    expect(pending.askInputsEvents[0].items[0].kind).toBe("approval");
    const unapproved = await executeMcpToolCall("u1", f.tool.openai_tool_name, args, f.db);
    expect(unapproved.event.status).toBe("error");
    expect(unapproved.legalSource).toBeNull();
    const plan = await planMcpToolCall("u1", f.tool.openai_tool_name, args, f.db);
    if (plan.type !== "approval") throw new Error("expected approval");
    const result = await executeApprovedMcpToolCall("u1", { ...plan.item, id: "approved" }, f.db);
    expect(result.event).toMatchObject({ status: "ok", approval_id: "approved" });
    expect(result.legalSource).toMatchObject({ text: payload.text, document: { type: "legislation" } });
    expect(mocks.callTool).toHaveBeenCalledExactlyOnceWith({ name: "get_document", arguments: args }, undefined, expect.any(Object));
    f.connector.server_url = "https://replacement.example.com/mcp";
    expect((await executeApprovedMcpToolCall("u1", { ...plan.item, id: "approved" }, f.db)).legalSource).toBeNull();
    expect(mocks.callTool).toHaveBeenCalledOnce();
  });

  it("passes approved sources to the resumed request without persisting panel documents", async () => {
    const f = fixture();
    f.connector.read_only = false;
    f.tool.annotations.readOnlyHint = false;
    f.tool.requires_confirmation = true;
    const plan = await planMcpToolCall("u1", f.tool.openai_tool_name, args, f.db);
    if (plan.type !== "approval") throw new Error("expected approval");
    f.row.content = [
      { type: "ask_inputs", event_id: "ask1", items: [{ ...plan.item, id: "approved" }] },
      { type: "ask_inputs_response", ask_event_id: "ask1", responses: [{ id: "approved", kind: "approval", decision: "approve" }] },
    ];
    const onLegalSource = vi.fn();
    const events = await runApprovedConnectorActions({ db: f.db, chatId: "chat1", messageId: "a1", askEventId: "ask1", userId: "u1", onLegalSource });
    expect(onLegalSource).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ text: payload.text }));
    expect(events[0].status).toBe("ok");
    expect(JSON.stringify(f.row)).not.toContain("subdocuments");
    expect(JSON.stringify(f.row)).not.toContain("panel_document");
  });
});
