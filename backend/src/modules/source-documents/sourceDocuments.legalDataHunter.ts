// Legal Data Hunter (https://legaldatahunter.com/mcp) as a source provider.
//
// Legal Data Hunter is an MCP connector whose `get_document` tool returns a
// complete case, statute or piece of legal research, and whose
// `resolve_reference` tool returns the same document shape for a citation.
// Such a result becomes a citable source for the request (see
// sourceDocuments.providers.ts); the citation carries only this provider's
// document id, and the panel reads the document again through the viewer's
// own connection, with `get_document`, when it is opened.

import { isDeepStrictEqual } from "node:util";
import {
  executeMcpToolOnServer,
  sameMcpServerUrl,
  type McpCallRecord,
} from "../../lib/mcpConnectors";
import { teamOrgIdOf } from "../../lib/personalOrgs";
import type { ExternalSource } from "../../lib/sourceDocuments";
import type {
  SourceDocumentResult,
  SourceProvider,
  SourceProviderFetchArgs,
} from "./sourceDocuments.types";

export const LEGAL_DATA_HUNTER_URL = "https://legaldatahunter.com/mcp";
export const LEGAL_DATA_HUNTER_CONNECT_DETAIL =
  "Connect Legal Data Hunter in Settings → Connectors to view this source.";
/**
 * Characters of a Legal Data Hunter result the model receives, in place of
 * the general MAX_MCP_RESULT_CHARS. It matches the document-context limit so
 * a full court judgment usually fits; a longer document is cut off there and
 * stays readable in full through read_document. No other connector is
 * affected.
 */
export const LEGAL_DATA_HUNTER_RESULT_CHARS = 200_000;

const DOCUMENT_TOOL = "get_document";
/**
 * Resolves a loose citation ("547 U.S. 388") to the document(s) it names, in
 * a `documents` list of get_document's shape: with `include_full_text` each
 * carries its whole text, and the `source`/`source_id` it reports reopen the
 * same document through get_document.
 */
const RESOLVE_TOOL = "resolve_reference";
const MAX_SOURCE_TEXT_CHARS = 1_000_000;
type RecordValue = Record<string, unknown>;
type SourceContext = {
  connectorId: string;
  serverUrl: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

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
/**
 * A citation's stable id for an LDH document: the connector it was read
 * through plus the provider's identifiers, each length-prefixed so neither
 * can be confused with a separator.
 */
export function legalDataHunterDocumentId(
  connectorId: string,
  provider: string,
  providerId: string,
): string {
  return `mcp:${connectorId}:${provider.length}:${provider}:${providerId.length}:${providerId}`;
}

/** The provider identifiers in an id from `legalDataHunterDocumentId`, or null. */
export function parseLegalDataHunterDocumentId(
  documentId: string,
): { connectorId: string; provider: string; providerId: string } | null {
  const match = /^mcp:([^:]+):(\d+):/.exec(documentId);
  if (!match) return null;
  const connectorId = match[1];
  let rest = documentId.slice(match[0].length);
  const providerLength = Number(match[2]);
  const provider = rest.slice(0, providerLength);
  rest = rest.slice(providerLength);
  const second = /^:(\d+):/.exec(rest);
  if (!second) return null;
  const providerId = rest.slice(second[0].length);
  if (
    provider.length !== providerLength ||
    providerId.length !== Number(second[1]) ||
    !identifier(provider) ||
    !identifier(providerId)
  )
    return null;
  return { connectorId, provider, providerId };
}

export function isLegalDataHunterUrl(value: string): boolean {
  return sameMcpServerUrl(value, LEGAL_DATA_HUNTER_URL);
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

/**
 * A complete document in get_document's shape, or null. The body travels in
 * `text`, not in the panel document, so a citation never carries it; the
 * panel reads it again when the source opens.
 */
function documentSource(
  payload: RecordValue | null,
  connectorId: string,
): ExternalSource | null {
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
  // A snippet reports `text_truncated: true`; a full text omits the field
  // or reports false.
  if (!provider || !providerId || !title || !body || !type || !officialUrl ||
      ("text_truncated" in (payload ?? {}) && payload?.text_truncated !== false)) return null;

  const documentId = legalDataHunterDocumentId(connectorId, provider, providerId);
  return {
    text: body,
    document: {
      document_id: documentId, title, type, metadata: [], quotes: [],
      actions: [{ type: "link", url: officialUrl }],
      // `text`, not `html`: the shared panel renders this as plain text once
      // the body is read again from the provider.
      subdocuments: [{ document_id: `${documentId}:text`, title, type: "html" }],
    },
  };
}

function fromCanonicalServer(result: unknown, context: SourceContext, toolName: string): boolean {
  return isLegalDataHunterUrl(context.serverUrl) && context.toolName === toolName &&
    record(result)?.isError !== true;
}

/**
 * Accept only a complete get_document result from the canonical connector,
 * for the document that was requested.
 */
export function extractLegalDataHunterSource(
  result: unknown,
  context: SourceContext,
): ExternalSource | null {
  if (!fromCanonicalServer(result, context, DOCUMENT_TOOL)) return null;
  const payload = resultPayload(result);
  const source = documentSource(payload, context.connectorId);
  return source &&
    identifier(context.arguments.source) === payload?.source &&
    identifier(context.arguments.source_id) === payload?.source_id
    ? source : null;
}

/**
 * The complete documents a canonical get_document or resolve_reference result
 * carries, in the order the result lists them; empty when there are none.
 *
 * A resolve_reference call names a citation, not a document, so its
 * documents are bound to the identity the canonical server reports for them,
 * which is the one a saved citation re-reads with get_document. Its result
 * counts only when every document in it is complete and distinct: the model
 * is told the sources' handles in that same order, so a skipped snippet
 * would misalign them. A snippet can be fetched in full with get_document.
 */
export function extractLegalDataHunterSources(
  result: unknown,
  context: SourceContext,
): ExternalSource[] {
  if (context.toolName === DOCUMENT_TOOL) {
    const source = extractLegalDataHunterSource(result, context);
    return source ? [source] : [];
  }
  if (!fromCanonicalServer(result, context, RESOLVE_TOOL)) return [];
  const documents = resultPayload(result)?.documents;
  if (!Array.isArray(documents)) return [];
  const sources: ExternalSource[] = [];
  const ids = new Set<string>();
  for (const document of documents) {
    const source = documentSource(record(document), context.connectorId);
    if (!source || ids.has(source.document.document_id)) return [];
    ids.add(source.document.document_id);
    sources.push(source);
  }
  return sources;
}

async function fetchDocument(args: SourceProviderFetchArgs): Promise<SourceDocumentResult> {
  const reference = parseLegalDataHunterDocumentId(args.documentId);
  if (!reference) {
    return { ok: false, kind: "not_found", detail: "Document not found" };
  }
  const owner = { userId: args.userId, orgId: await teamOrgIdOf(args.db, args.orgId) };
  const result = await executeMcpToolOnServer(
    owner,
    {
      serverUrl: LEGAL_DATA_HUNTER_URL,
      toolName: DOCUMENT_TOOL,
      arguments: {
        source: reference.provider,
        source_id: reference.providerId,
        include_full_text: true,
      },
      preferConnectorId: reference.connectorId,
    },
    args.db,
  );
  if (!result) {
    return { ok: false, kind: "credentials", detail: LEGAL_DATA_HUNTER_CONNECT_DETAIL };
  }
  const source =
    result.event.status === "ok" && result.call
      ? extractLegalDataHunterSource(result.call.result, result.call)
      : null;
  if (!source) {
    return {
      ok: false,
      kind: "error",
      error: new Error("Legal Data Hunter source unavailable"),
    };
  }
  // The document keeps the id it was cited under, so the citation's quote
  // targets still match whichever connector served it this time.
  return {
    ok: true,
    document: {
      ...source.document,
      document_id: args.documentId,
      subdocuments: source.document.subdocuments?.map((subdocument) => ({
        ...subdocument,
        document_id: `${args.documentId}:text`,
        text: source.text,
      })),
    },
  };
}

export const legalDataHunterSourceProvider: SourceProvider = {
  id: "legal_data_hunter",
  // The whole `mcp:` namespace is this provider's: a malformed id is still
  // not an upload, so it fails closed as not found rather than falling
  // through to the uploaded-document paths.
  ownsDocumentId: (documentId) => documentId.startsWith("mcp:"),
  quoteVerification: "exact",
  fetch: fetchDocument,
  fromMcpCall: (call: McpCallRecord) => extractLegalDataHunterSources(call.result, call),
  mcpResultChars: (call) =>
    isLegalDataHunterUrl(call.serverUrl) ? LEGAL_DATA_HUNTER_RESULT_CHARS : undefined,
};
