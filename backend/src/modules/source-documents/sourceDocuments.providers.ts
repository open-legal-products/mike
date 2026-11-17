// The source-provider registry and the lookups built on it.
//
// Adding a provider means adding one implementation file and listing it here:
// the panel endpoint, the chat engine's citation checks and the MCP result
// hook all consult this list rather than naming providers.

import type { McpCallRecord } from "../../lib/mcpConnectors";
import type { ExternalSource, SourceDocument } from "../../lib/sourceDocuments";
import { courtlistenerSourceProvider } from "./sourceDocuments.courtlistener";
import { legalDataHunterSourceProvider } from "./sourceDocuments.legalDataHunter";
import type {
  SourceDocumentResult,
  SourceProvider,
  SourceProviderFetchArgs,
} from "./sourceDocuments.types";

export const SOURCE_PROVIDERS: readonly SourceProvider[] = [
  courtlistenerSourceProvider,
  legalDataHunterSourceProvider,
];

/** The provider that issued an opaque source-document id, if any. */
export function sourceProviderFor(documentId: string): SourceProvider | null {
  return SOURCE_PROVIDERS.find((provider) => provider.ownsDocumentId(documentId)) ?? null;
}

/**
 * Whether an id names a provider-backed source rather than an uploaded
 * document. Such an id can be cited only through a source read during the
 * same request: there is no stored text to verify a quote against otherwise.
 */
export function isExternalSourceDocumentId(documentId: string): boolean {
  return sourceProviderFor(documentId) !== null;
}

/**
 * A complete document carried in a successful MCP tool call, from whichever
 * provider recognises the call. Providers bind the document to the canonical
 * server and the requested identity, so an unrelated server cannot plant a
 * citable source.
 */
export function externalSourceFromMcpCall(call: McpCallRecord): ExternalSource | null {
  for (const provider of SOURCE_PROVIDERS) {
    const source = provider.fromMcpCall?.(call);
    if (source) return { ...source, document: stamped(source.document, provider) };
  }
  return null;
}

/** The panel document with its provider's identity, so the client needs no id rules. */
function stamped(document: SourceDocument, provider: SourceProvider): SourceDocument {
  return {
    ...document,
    provider: provider.id,
    quote_verification: provider.quoteVerification,
  };
}

/**
 * The result allowance a provider grants a call to its own server, for the
 * MCP call options; undefined keeps the general cap.
 */
export function mcpResultCharsFor(
  call: Pick<McpCallRecord, "serverUrl" | "toolName">,
): number | undefined {
  for (const provider of SOURCE_PROVIDERS) {
    const chars = provider.mcpResultChars?.(call);
    if (chars !== undefined) return chars;
  }
  return undefined;
}

// Concurrent requests for the same document by the same user share one
// provider fetch; the entry is dropped as soon as that fetch settles.
const documentFetches = new Map<string, Promise<SourceDocumentResult>>();

/**
 * Hydrate an opaque source-document id that needs provider-backed content.
 * File documents use the existing single-document viewer endpoints; every
 * other id is dispatched to the provider that owns it.
 */
export async function getSourceDocument(
  db: SourceProviderFetchArgs["db"],
  args: {
    userId: string;
    documentId: string;
    /**
     * The workspace the citation was opened from: its connections and tokens
     * are the ones used. Null for Personal.
     */
    orgId?: string | null;
  },
): Promise<SourceDocumentResult> {
  const provider = sourceProviderFor(args.documentId);
  if (!provider) {
    return { ok: false, kind: "not_found", detail: "Document not found" };
  }
  const orgId = args.orgId ?? null;
  const fetchKey = `${provider.id}:${args.userId}:${orgId ?? "personal"}:${args.documentId}`;
  let request = documentFetches.get(fetchKey);
  if (!request) {
    request = provider
      .fetch({ db, userId: args.userId, documentId: args.documentId, orgId })
      .then((result): SourceDocumentResult =>
        result.ok ? { ok: true, document: stamped(result.document, provider) } : result,
      )
      .catch((error: unknown): SourceDocumentResult => ({ ok: false, kind: "error", error }))
      .finally(() => documentFetches.delete(fetchKey));
    documentFetches.set(fetchKey, request);
  }
  return request;
}
