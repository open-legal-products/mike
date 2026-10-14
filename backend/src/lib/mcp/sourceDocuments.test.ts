import { describe, expect, it } from "vitest";
import { extractLegalDataHunterSource } from "./sourceDocuments";

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
        actions: [{ type: "link", label: "Official source", url: payload.url }],
        subdocuments: [{
          document_id: "mcp:connector-1:10:legifrance:12:JORFTEXT0001:text",
          title: payload.title,
          type: "html",
          text: payload.text,
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
