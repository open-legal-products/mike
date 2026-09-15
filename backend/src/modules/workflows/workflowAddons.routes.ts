// HTTP surface for the workflow add-on catalog, mounted at /workflow-addons.
// Handlers parse params/query, call the service layer in
// workflows.service.ts (implemented in workflows.addons.ts), and map its
// typed results onto status codes and JSON responses.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendDocumentDisplay } from "../../lib/documentDisplay";
import { sendInternalError } from "../../lib/httpError";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
  getWorkflowAddon,
  importWorkflowAddon,
  listWorkflowAddons,
  loadWorkflowAddonAssetDisplay,
  withDatabaseWorkflow,
  type WorkflowAddonImportFailure,
  type WorkflowRecord,
} from "./workflows.service";

export const workflowAddonsRouter = Router();

// The asset-copy rollback answers 500 with its own detail; every other
// failure goes through the shared status-code policy in lib/serviceResult.
function sendImportFailure(res: Response, failure: WorkflowAddonImportFailure) {
  if (failure.kind === "assets_copy_failed") {
    return void res.status(500).json({ detail: failure.detail });
  }
  return void sendServiceFailure(res, failure);
}

// GET /workflow-addons
workflowAddonsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const type = typeof req.query.type === "string" ? req.query.type : null;
    const result = await listWorkflowAddons(db, { type });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

// GET /workflow-addons/:addonId/assets/:assetId/display
workflowAddonsRouter.get(
  "/:addonId/assets/:assetId/display",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await loadWorkflowAddonAssetDisplay(db, {
      addonId: req.params.addonId,
      assetId: req.params.assetId,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    // The pre-move handler had the streaming call inside the same try/catch
    // as the load, so a throw here answered with the internal-error body
    // rather than falling through to the router's error middleware.
    try {
      sendDocumentDisplay(res, result.data);
    } catch (error) {
      return void sendInternalError(res, error);
    }
  }),
);

// GET /workflow-addons/:addonId
workflowAddonsRouter.get(
  "/:addonId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const db = createServerSupabase();
    const result = await getWorkflowAddon(db, { addonId: req.params.addonId });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.json(result.data);
  }),
);

// POST /workflow-addons/:addonId/import
workflowAddonsRouter.post(
  "/:addonId/import",
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const db = createServerSupabase();
    const result = await importWorkflowAddon(db, {
      addonId: req.params.addonId,
      userId,
    });
    if (!result.ok) return void sendImportFailure(res, result);
    // Serialize through the workflows facade so the imported workflow comes
    // back in exactly the shape GET /workflows/:id returns. Rebuilding that
    // shape by hand had drifted from the route on four fields: metadata.name,
    // the default contributor, version, and is_default.
    res.status(201).json({
      ...withDatabaseWorkflow(result.data as unknown as WorkflowRecord),
      is_owner: true,
      allow_edit: true,
      access_role: "owner",
      // An imported add-on is never one of the installed default workflows.
      is_default: false,
    });
  }),
);

workflowAddonsRouter.use(routerErrorHandler("[workflow-addons]"));
