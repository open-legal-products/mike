// HTTP layer for the source-documents module.
//
// Mounted at /documents (the `documents` module mounts at /single-documents);
// serves the case-law source corpus. The handler parses the opaque document
// id, calls sourceDocuments.service, and maps its typed result onto a status
// code and JSON — an unresolvable id is a 404, an upstream provider failure a
// 502 whose raw error never reaches the client.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import { getSourceDocument } from "./sourceDocuments.service";

export const sourceDocumentsRouter = Router();

sourceDocumentsRouter.use(requireAuth);

sourceDocumentsRouter.get("/:documentId", async (req, res) => {
  try {
    const result = await getSourceDocument(createServerSupabase(), {
      userId: String(res.locals.userId ?? ""),
      documentId: String(req.params.documentId ?? ""),
    });
    if (result.ok) return res.json(result.document);
    if (result.kind === "not_found") {
      return res.status(404).json({ detail: result.detail });
    }
    return sendInternalError(res, result.error, 502);
  } catch (error) {
    // Obtaining the database handle is the only step outside the service's
    // own containment; keep it answering the same 502 rather than hanging.
    return sendInternalError(res, error, 502);
  }
});
