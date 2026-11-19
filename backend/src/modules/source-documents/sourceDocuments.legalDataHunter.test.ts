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
  extractLegalDataHunterSources,
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

describe("Legal Data Hunter resolve_reference results", () => {
  const resolveContext = {
    connectorId: "connector-1",
    serverUrl: LEGAL_DATA_HUNTER_URL,
    toolName: "resolve_reference",
    arguments: { reference: "547 U.S. 388 (2006)", hint_country: "US", hint_type: "case_law", include_full_text: true },
  };
  // The live endpoint's shape: a JSON text block without structured content,
  // and no `text_truncated` on a full text.
  const ebay = {
    source: "US/CaselawAccessProject",
    source_id: "us_547/html/0388-01.html",
    data_type: "case_law",
    title: "EBAY INC. et al. v. MERCEXCHANGE, L. L. C.",
    text: "According to well-established principles of equity, a plaintiff seeking a permanent injunction must satisfy a four-factor test before a court may grant such relief.",
    url: "https://www.courtlistener.com/c/us/547/388/",
    country: "US",
    court: "US courts (Harvard Caselaw Access Project)",
    court_tier: 1,
    meta: { case_number: "05-130" },
  };
  const statute = {
    source: "US/USCode", source_id: "usc-2024-t35-s283", data_type: "legislation",
    title: "§283. Injunction",
    text: "The several courts having jurisdiction of cases under this title may grant injunctions in accordance with the principles of equity.",
    url: "https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title35-section283",
  };
  const resolved = (documents: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ resolved: true, engine: "v2", match_type: "exact", documents, elapsed_ms: 2686 }) }],
  });
  const sources = (result: unknown, overrides: Partial<typeof resolveContext> = {}) =>
    extractLegalDataHunterSources(result, { ...resolveContext, ...overrides });

  it("makes a complete resolved document the same source get_document would", () => {
    const fromGetDocument = extractLegalDataHunterSource(
      { content: [{ type: "text", text: JSON.stringify(ebay) }] },
      { ...resolveContext, toolName: "get_document", arguments: { source: ebay.source, source_id: ebay.source_id, include_full_text: true } },
    );
    expect(fromGetDocument).not.toBeNull();
    expect(sources(resolved([ebay]))).toEqual([fromGetDocument]);
    expect(sources({ structuredContent: { resolved: true, documents: [ebay] } })).toEqual([fromGetDocument]);
    // Bound to the identity LDH reports, which a saved citation re-reads.
    expect(sources(resolved([ebay]))[0].document).toMatchObject({
      document_id: legalDataHunterDocumentId("connector-1", ebay.source, ebay.source_id),
      type: "case",
      actions: [{ type: "link", url: ebay.url }],
    });
  });

  it("makes each of several complete documents a source, in the order listed", () => {
    expect(sources(resolved([ebay, statute])).map((source) => [source.document.title, source.document.type, source.text])).toEqual([
      [ebay.title, "case", ebay.text],
      [statute.title, "legislation", statute.text],
    ]);
  });

  it.each([
    ["a snippet", [{ ...ebay, text_truncated: true, full_text_size: 18_309 }]],
    ["a snippet beside a complete document", [statute, { ...ebay, text_truncated: true }]],
    ["an unusable document beside a complete one", [ebay, { ...statute, url: "http://example.com/law" }]],
    ["a document over the source limit", [ebay, { ...statute, text: "a".repeat(1_000_001) }]],
    ["the same document twice", [ebay, { ...ebay, text: `${ebay.text} Amended.` }]],
    ["a non-object entry", [ebay, "not a document"]],
  ])("registers nothing for a result with %s", (_label, documents) => {
    expect(sources(resolved(documents))).toEqual([]);
  });

  it("registers nothing for an unresolved, empty, malformed or failed result", () => {
    for (const result of [
      { content: [{ type: "text", text: JSON.stringify({ resolved: false, engine: "v2", match_type: "not_found", elapsed_ms: 2000 }) }] },
      resolved([]),
      resolved("not a list"),
      resolved({ 0: ebay }),
      { content: [{ type: "text", text: "not JSON" }] },
      { ...resolved([ebay]), isError: true },
      // A get_document payload is not a resolved list.
      { content: [{ type: "text", text: JSON.stringify(ebay) }] },
    ]) {
      expect(sources(result)).toEqual([]);
    }
  });

  it("accepts only the canonical endpoint's resolve_reference and get_document tools", () => {
    for (const serverUrl of ["https://legaldatahunter.com.evil.test/mcp", "https://legaldatahunter.com/mcp?variant=other", "http://legaldatahunter.com/mcp"]) {
      expect(sources(resolved([ebay]), { serverUrl })).toEqual([]);
    }
    expect(sources(resolved([ebay]), { toolName: "search" })).toEqual([]);
    // The single-document extractor, which the panel re-read uses, stays get_document only.
    expect(extractLegalDataHunterSource(resolved([ebay]), resolveContext)).toBeNull();
  });

  it("keeps get_document results bound to the requested identity", () => {
    expect(extractLegalDataHunterSources({ structuredContent: payload }, context)).toEqual([extract()]);
    expect(extractLegalDataHunterSources({ structuredContent: payload }, { ...context, arguments: { ...context.arguments, source_id: "other" } })).toEqual([]);
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

  it("reopens a source resolved by resolve_reference through get_document", async () => {
    const resolvedCall = call({
      toolName: "resolve_reference",
      arguments: { reference: "art. 1103 code civil", hint_country: "FR", include_full_text: true },
      result: { content: [{ type: "text", text: JSON.stringify({ resolved: true, match_type: "exact", documents: [payload] }) }] },
    });
    const [source] = legalDataHunterSourceProvider.fromMcpCall?.(resolvedCall) ?? [];
    expect(source?.document.document_id).toBe(documentId);
    mocks.executeMcpToolOnServer.mockResolvedValue(okResult(call()));
    const result = await legalDataHunterSourceProvider.fetch({ db, userId: "u1", documentId: source.document.document_id, orgId: null });
    if (!result.ok) throw new Error(result.kind);
    expect(mocks.executeMcpToolOnServer).toHaveBeenCalledWith(
      { userId: "u1", orgId: "org-1" },
      { serverUrl: LEGAL_DATA_HUNTER_URL, toolName: "get_document", arguments: { ...args, include_full_text: true }, preferConnectorId: "c1" },
      db,
    );
    expect(result.document.subdocuments?.[0]).toMatchObject({ document_id: `${documentId}:text`, text: source.text });
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
