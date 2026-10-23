// HTTP layer for the source-documents module.
//
// Mounted at /documents (the `documents` module mounts at /single-documents);
// serves the case-law source corpus. The handler parses the opaque document
// id, calls sourceDocuments.service, and maps its typed result onto a status
// code and JSON — an unresolvable id is a 404, a missing or rejected
// CourtListener token a 400 with a fixed message, and an upstream provider
// failure a 502 whose raw error never reaches the client. `?workspace=`
// names the workspace the citation was opened from, whose CourtListener
// token is used; its absence means Personal.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendInternalError } from "../../lib/httpError";
import {
  PERSONAL_WORKSPACE,
  resolveWorkspaceFilter,
  sendWorkspaceFailure,
} from "../../lib/workspace";
import { getSourceDocument } from "./sourceDocuments.service";

export const sourceDocumentsRouter = Router();

sourceDocumentsRouter.use(requireAuth);

sourceDocumentsRouter.get("/:documentId", asyncRoute(async (req, res) => {
  try {
    const db = createServerSupabase();
    const userId = String(res.locals.userId ?? "");
    const workspace = await resolveWorkspaceFilter(db, userId, req.query.workspace);
    if (!workspace.ok) return sendWorkspaceFailure(res, workspace);
    const result = await getSourceDocument(db, {
      userId,
      documentId: String(req.params.documentId ?? ""),
      orgId:
        workspace.workspace && workspace.workspace !== PERSONAL_WORKSPACE
          ? workspace.workspace
          : null,
    });
    if (result.ok) return res.json(result.document);
    if (result.kind === "not_found") {
      return res.status(404).json({ detail: result.detail });
    }
    if (result.kind === "credentials") {
      return res.status(400).json({ detail: result.detail });
    }
    return sendInternalError(res, result.error, 502);
  } catch (error) {
    // Obtaining the database handle is the only step outside the service's
    // own containment; keep it answering the same 502 rather than hanging.
    return sendInternalError(res, error, 502);
  }
}));

sourceDocumentsRouter.use(routerErrorHandler("[source-documents]"));
