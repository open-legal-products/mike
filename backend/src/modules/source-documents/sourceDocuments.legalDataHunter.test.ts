import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../lib/supabase";
import type { McpCallRecord, McpToolCallResult } from "../../lib/mcpConnectors";

const mocks = vi.hoisted(() => ({
  executeMcpToolOnServer: vi.fn(),
  teamOrgIdOf: vi.fn(),
}));
vi.mock("../../lib/mcpConnectors", async (original) => ({
  ...(await original<typeof import("../../lib/mcpConnectors")>()),
  executeMcpToolOnServer: mocks.executeMcpToolOnServer,
}));
vi.mock("../../lib/personalOrgs", () => ({ teamOrgIdOf: mocks.teamOrgIdOf }));

import {
  extractLegalDataHunterSource,
  LEGAL_DATA_HUNTER_CONNECT_DETAIL,
  LEGAL_DATA_HUNTER_RESULT_CHARS,
  LEGAL_DATA_HUNTER_URL,
  legalDataHunterDocumentId,
  legalDataHunterSourceProvider,
  parseLegalDataHunterDocumentId,
} from "./sourceDocuments.legalDataHunter";
import { mcpResultCharsFor, sourceProviderFor } from "./sourceDocuments.providers";

const context = {
  connectorId: "connector-1",
  serverUrl: "https://legaldatahunter.com/mcp",
  toolName: "get_document",
  arguments: { source: "legifrance", source_id: "JORFTEXT0001" },
};
const payload = {
  ...context.arguments,
  data_type: "legislation",
  title: "Code civil, article 1103",
  text: "  Les contrats légalement formés tiennent lieu de loi.\n",
  text_truncated: false,
  url: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000006436298",
};
const extract = (data: unknown = payload) =>
  extractLegalDataHunterSource({ structuredContent: data }, context);

describe("Legal Data Hunter source documents", () => {
  it.each([{ url: "https://other.example/law" }, { metadata: { court: "different" } }, { text: "different" }])("rejects conflicting full representations %#", (override) => {
    expect(extractLegalDataHunterSource({ structuredContent: payload, content: [{ type: "text", text: JSON.stringify({ ...payload, ...override }) }] }, context)).toBeNull();
  });
  it("accepts equivalent representations regardless of object key order", () => {
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(extractLegalDataHunterSource({ structuredContent: payload, content: [{ type: "text", text: JSON.stringify(reordered) }] }, context)?.text).toBe(payload.text);
  });
  it("rejects extra malformed or conflicting text blocks", () => {
    for (const text of ["not JSON", JSON.stringify({ ...payload, title: "other" })]) {
      expect(extractLegalDataHunterSource({ content: [{ type: "text", text: JSON.stringify(payload) }, { type: "text", text }] }, context)).toBeNull();
    }
  });
  it.each(["structuredContent", "content"])("accepts complete %s without changing source bytes", (format) => {
    const result = format === "structuredContent"
      ? { structuredContent: payload }
      : { content: [{ type: "text", text: JSON.stringify(payload) }] };
    expect(extractLegalDataHunterSource(result, context)).toEqual({
      text: payload.text,
      document: {
        document_id: "mcp:connector-1:10:legifrance:12:JORFTEXT0001",
        title: payload.title,
        type: "legislation",
        metadata: [],
        quotes: [],
        actions: [{ type: "link", url: payload.url }],
        // The body is in `text` above, never in the panel document.
        subdocuments: [{
          document_id: "mcp:connector-1:10:legifrance:12:JORFTEXT0001:text",
          title: payload.title,
          type: "html",
        }],
      },
    });
  });
  it.each([["case_law", "case"], ["legislation", "legislation"], ["doctrine", "legal_research"]])("maps %s to %s", (data_type, type) => {
    expect(extract({ ...payload, data_type })?.document.type).toBe(type);
  });
  it.each([
    { source: "other" }, { source_id: "other" }, { source: " legifrance" },
    { source_id: "" }, { source_id: 1 }, { source: "a".repeat(2049) },
    { title: " " }, { title: "a".repeat(501) }, { data_type: "unknown" },
    { text: "\u2003\n" }, { text: null }, { text: "a".repeat(1_000_001) },
    { text_truncated: true }, { text_truncated: "false" }, { text_truncated: null },
    { url: "javascript:alert(1)" }, { url: "http://example.com/law" },
    { url: "not a url" }, { url: "https://user:password@example.com/law" },
  ])("rejects invalid payload fields (case %#)", (override) => {
    expect(extract({ ...payload, ...override })).toBeNull();
  });
  it.each([
    "http://legaldatahunter.com/mcp", "https://legaldatahunter.com.evil.test/mcp",
    "https://legaldatahunter.com/mcp?variant=other", "https://legaldatahunter.com/mcp#other",
    "https://legaldatahunter.com:444/mcp", "https://user:pass@legaldatahunter.com/mcp",
    "https://legaldatahunter.com/other", "invalid",
  ])("rejects noncanonical endpoint %s", (serverUrl) => {
    expect(extractLegalDataHunterSource({ structuredContent: payload }, { ...context, serverUrl })).toBeNull();
  });
  it("rejects search previews, error results, and request mismatches", () => {
    expect(extractLegalDataHunterSource({ structuredContent: payload }, { ...context, toolName: "search" })).toBeNull();
    expect(extractLegalDataHunterSource({ isError: true, structuredContent: payload }, context)).toBeNull();
    expect(extractLegalDataHunterSource({ structuredContent: payload }, { ...context, arguments: { ...context.arguments, source_id: "other" } })).toBeNull();
    expect(extractLegalDataHunterSource({ structuredContent: payload }, { ...context, arguments: {} })).toBeNull();
  });
  it("fails closed on malformed envelopes and does not replace invalid structured content with text JSON", () => {
    for (const result of [null, [], {}, { content: [{ type: "text", text: "not JSON" }] }, { structuredContent: {}, content: [{ type: "text", text: JSON.stringify(payload) }] }]) {
      expect(extractLegalDataHunterSource(result, context)).toBeNull();
    }
  });
  it("keeps provider/id boundaries and connector identities distinct", () => {
    const source = (provider: string, id: string, connectorId = context.connectorId) =>
      extractLegalDataHunterSource({ structuredContent: { ...payload, source: provider, source_id: id } }, { ...context, connectorId, arguments: { source: provider, source_id: id } });
    expect(source("a:b", "c")?.document.document_id).not.toBe(source("a", "b:c")?.document.document_id);
    expect(source("a", "b")?.document.document_id).not.toBe(source("a", "b", "connector-2")?.document.document_id);
  });
});

describe("Legal Data Hunter document ids", () => {
  it.each([
    ["legifrance", "JORFTEXT0001"],
    ["a:b", "c"],
    ["a", "b:c"],
    ["uk", "ewca/crim/2025/472"],
  ])("reads back the provider identifiers of %s / %s", (provider, providerId) => {
    expect(
      parseLegalDataHunterDocumentId(legalDataHunterDocumentId("connector-1", provider, providerId)),
    ).toEqual({ connectorId: "connector-1", provider, providerId });
  });

  it("matches the id the extractor gives a source", () => {
    const source = extractLegalDataHunterSource({ structuredContent: payload }, context);
    expect(source?.document.document_id).toBe(
      legalDataHunterDocumentId(context.connectorId, payload.source, payload.source_id),
    );
  });

  it.each([
    "case:123",
    "mcp:connector-1",
    "mcp:connector-1:5:legi",
    "mcp:connector-1:10:legifrance:99:JORFTEXT0001",
    "mcp:connector-1:10:legifrance:3:JORFTEXT0001",
    "mcp:connector-1:0::12:JORFTEXT0001",
  ])("rejects %s", (documentId) => {
    expect(parseLegalDataHunterDocumentId(documentId)).toBeNull();
  });
});

describe("Legal Data Hunter as a source provider", () => {
  const args = context.arguments;
  const documentId = legalDataHunterDocumentId("c1", args.source, args.source_id);
  const db = {} as Db;
  const call = (overrides: Partial<McpCallRecord> = {}): McpCallRecord => ({
    connectorId: "c1",
    serverUrl: LEGAL_DATA_HUNTER_URL,
    toolName: "get_document",
    arguments: { ...args, include_full_text: true },
    result: { structuredContent: payload },
    ...overrides,
  });
  const okResult = (record: McpCallRecord): McpToolCallResult => ({
    content: "",
    call: record,
    event: {
      type: "mcp_tool_call",
      connector_id: record.connectorId,
      connector_name: "Legal Data Hunter",
      tool_name: "get_document",
      openai_tool_name: "mcp_c1_get_document",
      status: "ok",
    },
  });

  beforeEach(() => {
    mocks.executeMcpToolOnServer.mockReset();
    mocks.teamOrgIdOf.mockReset().mockResolvedValue("org-1");
  });

  it("owns mcp: ids and verifies quotes exactly", () => {
    expect(sourceProviderFor(documentId)?.id).toBe("legal_data_hunter");
    expect(sourceProviderFor(documentId)?.quoteVerification).toBe("exact");
    // The namespace is claimed whole, so a malformed id never reaches the
    // uploaded-document paths; fetch answers not_found for it below.
    expect(sourceProviderFor("mcp:c1:not-a-reference")?.id).toBe("legal_data_hunter");
    expect(sourceProviderFor("case:1")?.id).toBe("courtlistener");
  });

  it("grants its own server, and only it, the larger result allowance", () => {
    expect(mcpResultCharsFor({ serverUrl: LEGAL_DATA_HUNTER_URL, toolName: "get_document" })).toBe(LEGAL_DATA_HUNTER_RESULT_CHARS);
    expect(mcpResultCharsFor({ serverUrl: `${LEGAL_DATA_HUNTER_URL}/`, toolName: "search" })).toBe(LEGAL_DATA_HUNTER_RESULT_CHARS);
    expect(LEGAL_DATA_HUNTER_RESULT_CHARS).toBeGreaterThan(60_000);
    for (const serverUrl of ["https://mcp.slack.com/mcp", "https://legaldatahunter.com.evil.test/mcp", "https://legaldatahunter.com/mcp?x=1"]) {
      expect(mcpResultCharsFor({ serverUrl, toolName: "get_document" })).toBeUndefined();
    }
  });

  it("asks a reader without a connection to connect one", async () => {
    mocks.executeMcpToolOnServer.mockResolvedValue(null);
    await expect(legalDataHunterSourceProvider.fetch({ db, userId: "u1", documentId, orgId: "org-1" })).resolves.toEqual({
      ok: false, kind: "credentials", detail: LEGAL_DATA_HUNTER_CONNECT_DETAIL,
    });
    expect(mocks.executeMcpToolOnServer).toHaveBeenCalledWith(
      { userId: "u1", orgId: "org-1" },
      { serverUrl: LEGAL_DATA_HUNTER_URL, toolName: "get_document", arguments: { ...args, include_full_text: true }, preferConnectorId: "c1" },
      db,
    );
  });

  it("returns the document under the cited id with its text in place", async () => {
    mocks.executeMcpToolOnServer.mockResolvedValue(okResult(call({ connectorId: "c2" })));
    const result = await legalDataHunterSourceProvider.fetch({ db, userId: "u1", documentId, orgId: null });
    if (!result.ok) throw new Error(result.kind);
    expect(result.document.document_id).toBe(documentId);
    expect(result.document.subdocuments).toEqual([{ document_id: `${documentId}:text`, title: payload.title, type: "html", text: payload.text }]);
  });

  it("treats a failed or unusable answer as an upstream error and a foreign id as not found", async () => {
    mocks.executeMcpToolOnServer.mockResolvedValue({ ...okResult(call()), event: { ...okResult(call()).event, status: "error", error: "boom" } });
    expect(await legalDataHunterSourceProvider.fetch({ db, userId: "u1", documentId, orgId: null })).toMatchObject({ ok: false, kind: "error" });
    mocks.executeMcpToolOnServer.mockResolvedValue(okResult(call({ result: { structuredContent: { ...payload, text_truncated: true } } })));
    expect(await legalDataHunterSourceProvider.fetch({ db, userId: "u1", documentId, orgId: null })).toMatchObject({ ok: false, kind: "error" });
    mocks.executeMcpToolOnServer.mockClear();
    expect(await legalDataHunterSourceProvider.fetch({ db, userId: "u1", documentId: "mcp:c1:broken", orgId: null })).toEqual({ ok: false, kind: "not_found", detail: "Document not found" });
    expect(mocks.executeMcpToolOnServer).not.toHaveBeenCalled();
  });
});
