// Business logic + data-access for the source-documents module.
//
// Service layer behind sourceDocuments.routes.ts. It takes an explicit
// Supabase client (`db`) plus request-derived primitives, hydrates an opaque
// source-document id from its provider, normalizes the payload, and RETURNS a
// typed result. It never touches req/res.
//
// The failure union is module-specific rather than the shared `ServiceResult`
// because an upstream provider failure answers 502, a status the shared
// vocabulary does not carry.

import type { Db } from "../../lib/supabase";
import {
  COURTLISTENER_TOKEN_REQUIRED_MESSAGE,
  getCourtlistenerCaseOpinions,
} from "../../lib/courtlistener";
import { getUserModelSettings } from "../user/user.service";
import {
  caseClusterId,
  normalizeCaseDocument,
  type SourceDocument,
} from "../../lib/sourceDocuments";
import {
  fetchLegalDataHunterSource,
  parseLegalDataHunterDocumentId,
} from "../../lib/mcpConnectors";
import { teamOrgIdOf } from "../../lib/personalOrgs";

export type SourceDocumentResult =
  | { ok: true; document: SourceDocument }
  | { ok: false; kind: "not_found"; detail: string }
  | { ok: false; kind: "credentials"; detail: string }
  | { ok: false; kind: "error"; error: unknown };

// A missing or rejected CourtListener token is the caller's to fix in Settings,
// not an upstream outage, so it answers 400 rather than 502 — a 502 sent the
// user off to check a service that was working fine. courtlistener.ts throws a
// fixed message when no token is configured and prefixes the upstream status
// when CourtListener refuses the one it was given; only those markers are read,
// never the upstream body, which echoes the rejected token back.
export const COURTLISTENER_CREDENTIAL_DETAIL =
  "CourtListener rejected the configured API token. Check it in Settings → Connectors.";

function isCourtlistenerCredentialError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    message === COURTLISTENER_TOKEN_REQUIRED_MESSAGE ||
    message.startsWith("CourtListener error (401") ||
    message.startsWith("CourtListener error (403")
  );
}

// Concurrent requests for the same document by the same user share one
// upstream fetch; the entry is dropped as soon as that fetch settles.
const documentFetches = new Map<string, Promise<unknown>>();

export const LEGAL_DATA_HUNTER_CONNECT_DETAIL =
  "Connect Legal Data Hunter in Settings → Connectors to view this source.";

const legalSourceFetches = new Map<string, Promise<SourceDocumentResult>>();

/**
 * An embedded Legal Data Hunter source is not stored with the chat: its text
 * is read again through the viewer's own LDH connection. The document keeps
 * the id it was cited under, so quote targets in the citation still match.
 */
async function getLegalDataHunterDocument(
  db: Db,
  args: { userId: string; documentId: string; orgId?: string | null },
): Promise<SourceDocumentResult> {
  const reference = parseLegalDataHunterDocumentId(args.documentId);
  if (!reference) {
    return { ok: false, kind: "not_found", detail: "Document not found" };
  }
  const owner = { userId: args.userId, orgId: await teamOrgIdOf(db, args.orgId) };
  const fetched = await fetchLegalDataHunterSource(owner, reference, db);
  if (!fetched.ok) {
    return fetched.kind === "not_connected"
      ? { ok: false, kind: "credentials", detail: LEGAL_DATA_HUNTER_CONNECT_DETAIL }
      : { ok: false, kind: "error", error: new Error("Legal Data Hunter source unavailable") };
  }
  const { document } = fetched.source;
  return {
    ok: true,
    document: {
      ...document,
      document_id: args.documentId,
      subdocuments: document.subdocuments?.map((subdocument) => ({
        ...subdocument,
        document_id: `${args.documentId}:text`,
      })),
    },
  };
}

/**
 * Hydrate an opaque source-document id that needs provider-backed content.
 * File documents use the existing single-document viewer endpoints; `case:*`
 * is the first provider implemented behind this normalized contract.
 */
export async function getSourceDocument(
  db: Db,
  args: {
    userId: string;
    documentId: string;
    /**
     * The workspace the citation was opened from: its CourtListener token
     * is the one used. Null for Personal.
     */
    orgId?: string | null;
  },
): Promise<SourceDocumentResult> {
  if (args.documentId.startsWith("mcp:")) {
    const fetchKey = `${args.userId}:${args.orgId ?? "personal"}:${args.documentId}`;
    let request = legalSourceFetches.get(fetchKey);
    if (!request) {
      request = getLegalDataHunterDocument(db, args)
        .catch((error: unknown): SourceDocumentResult => ({ ok: false, kind: "error", error }))
        .finally(() => legalSourceFetches.delete(fetchKey));
      legalSourceFetches.set(fetchKey, request);
    }
    return request;
  }
  const clusterId = caseClusterId(args.documentId);
  if (!clusterId) {
    return { ok: false, kind: "not_found", detail: "Document not found" };
  }

  try {
    // One Supabase client for the whole request: the settings lookup used to
    // build a second one by omitting `db`.
    const settings = await getUserModelSettings(args.userId, db, {
      orgId: args.orgId ?? null,
    });
    const fetchKey = `${args.userId}:${args.orgId ?? "personal"}:${args.documentId}`;
    let request = documentFetches.get(fetchKey);
    if (!request) {
      request = getCourtlistenerCaseOpinions({
        clusterId,
        db,
        includeFullText: true,
        maxChars: 50000,
        apiToken: settings.api_keys.courtlistener,
      }).finally(() => documentFetches.delete(fetchKey));
      documentFetches.set(fetchKey, request);
    }

    const fetched = await request;
    const value =
      fetched && typeof fetched === "object" && !Array.isArray(fetched)
        ? (fetched as Record<string, unknown>)
        : {};
    return {
      ok: true,
      document: normalizeCaseDocument({
        clusterId,
        caseName:
          typeof value.caseName === "string" ? value.caseName : undefined,
        citations: Array.isArray(value.citations)
          ? value.citations.filter(
              (citation): citation is string => typeof citation === "string",
            )
          : undefined,
        dateFiled:
          typeof value.dateFiled === "string" ? value.dateFiled : undefined,
        url: typeof value.url === "string" ? value.url : undefined,
        pdfUrl: typeof value.pdfUrl === "string" ? value.pdfUrl : undefined,
        opinions: Array.isArray(value.opinions) ? value.opinions : [],
      }),
    };
  } catch (error) {
    if (isCourtlistenerCredentialError(error)) {
      return {
        ok: false,
        kind: "credentials",
        detail: COURTLISTENER_CREDENTIAL_DETAIL,
      };
    }
    return { ok: false, kind: "error", error };
  }
}
