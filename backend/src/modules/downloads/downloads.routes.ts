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

// GET /download/signed/:token — the filesystem storage driver's presigned
// URL. Deliberately unauthenticated, exactly like the S3 presigned URLs it
// replaces: the browser reaches it through a bare <a> click or fetch with no
// Authorization header. The token IS the authorization — an expiring HMAC
// capability minted by an authenticated route (documents /url, workflow
// references) AFTER its own access check, scoped to one object. Registered
// before /:token so Express doesn't swallow it with the pattern below.
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

/**
 * PUT /download/signed/:token — the filesystem storage driver's stand-in for a
 * presigned S3 `PUT`, and the write half of the route above.
 *
 * Unauthenticated for the same reason the GET is: the browser sends this PUT
 * straight from the upload-session flow with no Authorization header, exactly
 * as it would to S3. The token is the authorization — minted by
 * `/upload-sessions` after its own access check, scoped to one staging key.
 *
 * Exported rather than registered on `downloadsRouter` because it must be
 * mounted ahead of the global JSON body parser: the body is streamed to disk,
 * never buffered, and a `.json` upload would otherwise be eaten by the parser.
 */
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
