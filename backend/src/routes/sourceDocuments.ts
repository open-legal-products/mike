import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { asyncRoute } from "../middleware/asyncRoute";
import { getCourtlistenerCaseOpinions } from "../lib/courtlistener";
import { createServerSupabase } from "../lib/supabase";
import { getUserModelSettings } from "../lib/userSettings";
import { caseClusterId, normalizeCaseDocument } from "../lib/sourceDocuments";
import { sendInternalError } from "../lib/httpError";

export const sourceDocumentsRouter = Router();

sourceDocumentsRouter.use(requireAuth);

const documentFetches = new Map<string, Promise<unknown>>();

// A missing or rejected CourtListener token is the caller's to fix in Settings,
// not an upstream outage, so it answers 400 rather than 502 — a 502 sent the
// user off to check a service that was working fine. courtlistener.ts throws a
// fixed message when no token is configured and prefixes the upstream status
// when CourtListener refuses the one it was given; only those markers are read,
// never the upstream body, which echoes the rejected token back.
const COURTLISTENER_CREDENTIAL_DETAIL =
  "CourtListener rejected the configured API token. Check it in Settings.";

function isCourtlistenerCredentialError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("COURTLISTENER_API_TOKEN must be set") ||
    message.startsWith("CourtListener error (401") ||
    message.startsWith("CourtListener error (403")
  );
}

// Hydrate opaque source-document IDs that need provider-backed content. File
// documents use the existing single-document viewer endpoints; `case:*` is the
// first provider implemented behind this normalized contract.
sourceDocumentsRouter.get(
  "/:documentId",
  asyncRoute(async (req, res) => {
    const documentId = String(req.params.documentId ?? "");
    const clusterId = caseClusterId(documentId);
    if (!clusterId) {
      return res.status(404).json({ detail: "Document not found" });
    }

    try {
      const userId = String(res.locals.userId ?? "");
      // One Supabase client for the whole request: the settings lookup and the
      // opinion fetch used to build one each.
      const db = createServerSupabase();
      const settings = await getUserModelSettings(userId, db);
      const fetchKey = `${userId}:${documentId}`;
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
      return res.json(
        normalizeCaseDocument({
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
      );
    } catch (error) {
      if (isCourtlistenerCredentialError(error)) {
        return res
          .status(400)
          .json({ detail: COURTLISTENER_CREDENTIAL_DETAIL });
      }
      return sendInternalError(res, error, 502);
    }
  }),
);
