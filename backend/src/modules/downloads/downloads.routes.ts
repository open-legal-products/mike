// HTTP layer for the downloads module.
//
// Route handlers parse params, call the downloads.service functions, and map
// their typed results onto status codes, headers, and JSON.

import { Router } from "express";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import { buildContentDisposition } from "../../lib/storage";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
    resolveBlobDownload,
    resolveTokenDownload,
    storeBlobUpload,
} from "./downloads.service";

export const downloadsRouter = Router();

downloadsRouter.get("/signed/:token", asyncRoute(async (req, res) => {
    const result = await resolveBlobDownload(req.params.token);
    if (!result.ok) return void sendServiceFailure(res, result);
    res.setHeader("Content-Type", result.data.contentType);
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", result.data.filename),
    );
    res.send(result.data.bytes);
}));

// Mounted before the JSON parser: a JSON document upload must remain a byte
// stream rather than being consumed as an API request body.
export const blobUploadHandler = asyncRoute(async (req, res) => {
    const result = await storeBlobUpload({
        token: req.params.token,
        contentType: String(req.headers["content-type"] ?? ""),
        body: req,
    });
    if (!result.ok) return void sendServiceFailure(res, result);
    res.status(200).json({ ok: true });
});

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, asyncRoute(async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();
    const result = await resolveTokenDownload(db, {
        token: req.params.token,
        userId,
        userEmail,
    });
    if (!result.ok)
        return void res.status(404).json({
            detail:
                result.kind === "invalid_link" ? "Invalid link" : "File not found",
        });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", result.filename),
    );
    res.send(result.bytes);
}));

downloadsRouter.use(routerErrorHandler("[downloads]"));
