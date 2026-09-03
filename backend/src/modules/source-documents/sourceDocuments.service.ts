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
import { getCourtlistenerCaseOpinions } from "../../lib/courtlistener";
import { getUserModelSettings } from "../user/user.service";
import {
  caseClusterId,
  normalizeCaseDocument,
  type SourceDocument,
} from "../../lib/sourceDocuments";

export type SourceDocumentResult =
  | { ok: true; document: SourceDocument }
  | { ok: false; kind: "not_found"; detail: string }
  | { ok: false; kind: "error"; error: unknown };

// Concurrent requests for the same document by the same user share one
// upstream fetch; the entry is dropped as soon as that fetch settles.
const documentFetches = new Map<string, Promise<unknown>>();

/**
 * Hydrate an opaque source-document id that needs provider-backed content.
 * File documents use the existing single-document viewer endpoints; `case:*`
 * is the first provider implemented behind this normalized contract.
 */
export async function getSourceDocument(
  db: Db,
  args: { userId: string; documentId: string },
): Promise<SourceDocumentResult> {
  const clusterId = caseClusterId(args.documentId);
  if (!clusterId) {
    return { ok: false, kind: "not_found", detail: "Document not found" };
  }

  try {
    const settings = await getUserModelSettings(args.userId);
    const fetchKey = `${args.userId}:${args.documentId}`;
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
    return { ok: false, kind: "error", error };
  }
}
