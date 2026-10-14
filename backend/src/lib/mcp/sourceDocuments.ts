import type { SourceDocument } from "@mike/contracts";
import { isDeepStrictEqual } from "node:util";

const LEGAL_DATA_HUNTER_URL = "https://legaldatahunter.com/mcp";
const MAX_SOURCE_TEXT_CHARS = 1_000_000;
type RecordValue = Record<string, unknown>;
type SourceContext = {
  connectorId: string;
  serverUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
};
export type LegalDataHunterSource = { text: string; document: SourceDocument };

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
}
function text(value: unknown, max = 2_048): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= max ? result : null;
}
function identifier(value: unknown): string | null {
  return typeof value === "string" && value === value.trim() &&
    value.length > 0 && value.length <= 2_048 ? value : null;
}
function isLegalDataHunterUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash &&
      `${url.origin}${url.pathname.replace(/\/+$/, "")}` === LEGAL_DATA_HUNTER_URL;
  } catch {
    return false;
  }
}
function resultPayload(result: unknown): RecordValue | null {
  const root = record(result);
  const structured = record(root?.structuredContent);
  if (!root || ("structuredContent" in root && !structured)) return null;
  let payload = structured;
  for (const block of Array.isArray(root?.content) ? root.content : []) {
    const value = record(block);
    if (value?.type !== "text") continue;
    if (typeof value.text !== "string") return null;
    try {
      const parsed = record(JSON.parse(value.text));
      if (!parsed || (payload && !isDeepStrictEqual(payload, parsed))) return null;
      payload = parsed;
    } catch {
      return null;
    }
  }
  return payload;
}

/** Accept only complete, identity-bound documents from the canonical connector. */
export function extractLegalDataHunterSource(
  result: unknown,
  context: SourceContext,
): LegalDataHunterSource | null {
  if (!isLegalDataHunterUrl(context.serverUrl) || context.toolName !== "get_document" ||
      record(result)?.isError === true) return null;
  const payload = resultPayload(result);
  const provider = identifier(payload?.source);
  const providerId = identifier(payload?.source_id);
  const title = text(payload?.title, 500);
  const sourceUrl = text(payload?.url);
  const body = typeof payload?.text === "string" && payload.text.trim() &&
    payload.text.length <= MAX_SOURCE_TEXT_CHARS ? payload.text : null;
  const type = payload?.data_type === "case_law" ? "case" :
    payload?.data_type === "legislation" ? "legislation" :
    payload?.data_type === "doctrine" ? "legal_research" : null;
  let officialUrl: string | null = null;
  try {
    const url = sourceUrl ? new URL(sourceUrl) : null;
    if (url?.protocol === "https:" && !url.username && !url.password) officialUrl = sourceUrl;
  } catch {
    // Invalid provider URL.
  }
  if (!provider || !providerId || !title || !body || !type || !officialUrl ||
      ("text_truncated" in (payload ?? {}) && payload?.text_truncated !== false) ||
      identifier(context.arguments.source) !== provider ||
      identifier(context.arguments.source_id) !== providerId) return null;

  const documentId = `mcp:${context.connectorId}:${provider.length}:${provider}:${providerId.length}:${providerId}`;
  return {
    text: body,
    document: {
      document_id: documentId, title, type, metadata: [], quotes: [],
      actions: [{ type: "link", label: "Official source", url: officialUrl }],
      // `text`, not `html`: the shared panel renders this as plain text.
      subdocuments: [{ document_id: `${documentId}:text`, title, type: "html", text: body }],
    },
  };
}
