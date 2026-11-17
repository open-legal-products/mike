// CourtListener case law (`case:<cluster_id>`) as a source provider.

import {
  COURTLISTENER_TOKEN_REQUIRED_MESSAGE,
  getCourtlistenerCaseOpinions,
} from "../../lib/courtlistener";
import { getUserModelSettings } from "../user/user.service";
import { caseClusterId, normalizeCaseDocument } from "../../lib/sourceDocuments";
import type { SourceProvider, SourceProviderFetchArgs, SourceDocumentResult } from "./sourceDocuments.types";

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

async function fetchCase(args: SourceProviderFetchArgs): Promise<SourceDocumentResult> {
  const clusterId = caseClusterId(args.documentId);
  if (!clusterId) {
    return { ok: false, kind: "not_found", detail: "Document not found" };
  }
  try {
    // One Supabase client for the whole request: the settings lookup used to
    // build a second one by omitting `db`.
    const settings = await getUserModelSettings(args.userId, args.db, {
      orgId: args.orgId,
    });
    const fetched: unknown = await getCourtlistenerCaseOpinions({
      clusterId,
      db: args.db,
      includeFullText: true,
      maxChars: 50000,
      apiToken: settings.api_keys.courtlistener,
    });
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

export const courtlistenerSourceProvider: SourceProvider = {
  id: "courtlistener",
  ownsDocumentId: (documentId) => caseClusterId(documentId) !== null,
  // Case quotes tolerate whitespace and punctuation drift, as uploads do.
  quoteVerification: "fuzzy",
  fetch: fetchCase,
};
