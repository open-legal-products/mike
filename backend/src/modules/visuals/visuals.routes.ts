// HTTP layer for visual exports. Handlers parse params and query, call the
// service, and map its results onto status codes and headers.

import { Router, type Response } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { sendServiceFailure, type ServiceFailure } from "../../lib/serviceResult";
import { buildContentDisposition } from "../../lib/storage";
import {
    createDocxFromVisual,
    exportVisual,
    visualDocx,
    visualExportCapabilities,
    visualSnapshot,
} from "./visuals.service";

export const visualsRouter = Router();

// A render that times out is the server's failure to answer in time, and a
// page the renderer rejects is the content's fault; neither fits the
// service's generic kinds.
function sendRenderFailure(res: Response, failure: ServiceFailure) {
    if (failure.kind !== "error" && failure.code === "render_timeout") {
        return void res.status(504).json({ code: failure.code, detail: failure.detail });
    }
    if (failure.kind !== "error" && failure.code === "render_failed") {
        return void res.status(422).json({ code: failure.code, detail: failure.detail });
    }
    sendServiceFailure(res, failure);
}

const versionParam = (value: unknown) => (typeof value === "string" && value ? value : null);

// GET /visuals/capabilities
visualsRouter.get("/capabilities", requireAuth, asyncRoute(async (_req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.json(await visualExportCapabilities());
}));

// GET /visuals/:documentId/snapshot?version_id=
visualsRouter.get("/:documentId/snapshot", requireAuth, asyncRoute(async (req, res) => {
    const result = await visualSnapshot(createServerSupabase(), {
        documentId: req.params.documentId,
        versionId: versionParam(req.query.version_id),
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result.data);
}));

// GET /visuals/:documentId/export?version_id=
visualsRouter.get("/:documentId/export", requireAuth, asyncRoute(async (req, res) => {
    const result = await exportVisual(createServerSupabase(), {
        documentId: req.params.documentId,
        versionId: versionParam(req.query.version_id),
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendRenderFailure(res, result);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", buildContentDisposition("attachment", result.data.filename));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(result.data.bytes);
}));

// GET /visuals/:documentId/docx?version_id=
visualsRouter.get("/:documentId/docx", requireAuth, asyncRoute(async (req, res) => {
    const result = await visualDocx(createServerSupabase(), {
        documentId: req.params.documentId,
        versionId: versionParam(req.query.version_id),
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendRenderFailure(res, result);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", buildContentDisposition("attachment", result.data.filename));
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(result.data.bytes);
}));

// POST /visuals/:documentId/docx  { version_id? }
visualsRouter.post("/:documentId/docx", requireAuth, asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as { version_id?: unknown };
    const result = await createDocxFromVisual(createServerSupabase(), {
        documentId: req.params.documentId,
        versionId: versionParam(body.version_id),
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string | undefined,
    });
    if (!result.ok) return void sendRenderFailure(res, result);
    res.status(201).json(result.data);
}));

visualsRouter.use(routerErrorHandler("[visuals]"));
