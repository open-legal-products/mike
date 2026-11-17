// Types shared by the source-documents module's provider implementations.
//
// A source provider owns one family of opaque source-document ids (`case:*`
// for CourtListener, `mcp:*` for Legal Data Hunter; families must not overlap)
// and knows how to hydrate such an id for the panel and,
// when the provider is reached through an MCP connector, how to recognise a
// complete document inside a tool result so the chat can cite it.

import type { Db } from "../../lib/supabase";
import type { McpCallRecord } from "../../lib/mcpConnectors";
import type { ExternalSource, SourceDocument } from "../../lib/sourceDocuments";

export type SourceDocumentResult =
  | { ok: true; document: SourceDocument }
  | { ok: false; kind: "not_found"; detail: string }
  | { ok: false; kind: "credentials"; detail: string }
  | { ok: false; kind: "error"; error: unknown };

export type SourceProviderFetchArgs = {
  db: Db;
  userId: string;
  documentId: string;
  /**
   * The workspace the citation was opened from, whose connections and tokens
   * are used. Null for Personal.
   */
  orgId: string | null;
};

export interface SourceProvider {
  /** Static identifier for diagnostics and request deduplication. */
  readonly id: string;
  /** Whether this provider issued the opaque source-document id. */
  ownsDocumentId(documentId: string): boolean;
  /**
   * How a cited quote is checked against this provider's text. `exact`
   * accepts only a verbatim occurrence, as a legal quotation must be; `fuzzy`
   * is the uploaded-document matcher that tolerates whitespace and
   * punctuation drift. Applied by the engine's citation verification and
   * stamped on the panel document, which highlights quotes the same way.
   */
  readonly quoteVerification: "exact" | "fuzzy";
  /** Reads the document again from the provider for display. */
  fetch(args: SourceProviderFetchArgs): Promise<SourceDocumentResult>;
  /**
   * A complete, identity-bound document carried in an MCP tool result, or
   * null when the call is not this provider's or the result is unusable.
   */
  fromMcpCall?(call: McpCallRecord): ExternalSource | null;
  /**
   * Characters of a tool result from this provider's server the model may
   * receive, when whole documents deserve more than the general MCP cap.
   * Undefined for a call that is not this provider's.
   */
  mcpResultChars?(call: Pick<McpCallRecord, "serverUrl" | "toolName">): number | undefined;
}
