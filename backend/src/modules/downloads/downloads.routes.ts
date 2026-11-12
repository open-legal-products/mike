// HTTP layer for the downloads module.
//
// Route handlers parse params, call the downloads.service functions, and map
// their typed results onto status codes, headers, and JSON.

import { Router, type Request, type Response } from "express";
import { pipeline } from "node:stream/promises";
import { requireAuth } from "../../middleware/auth";
import { asyncRoute, routerErrorHandler } from "../../middleware/asyncRoute";
import { createServerSupabase } from "../../lib/supabase";
import {
    StorageOperationError,
    buildContentDisposition,
} from "../../lib/storage";
import { sendServiceFailure } from "../../lib/serviceResult";
import {
    resolveBlobDownload,
    resolveTokenDownload,
    storeBlobUpload,
    type ObjectDownload,
} from "./downloads.service";

export const downloadsRouter = Router();

/**
 * Answer a download by streaming the object to the client, so a large file
 * costs a few chunks of memory rather than the whole object.
 *
 * - A matching If-None-Match answers 304, and HEAD answers headers only,
 *   both without reading the object.
 * - The object is opened before any header is written, so a store that
 *   cannot serve it fails into the router's error handler as an ordinary
 *   500 instead of a dropped connection.
 * - A failure after the first byte can no longer change the status: the
 *   pipeline destroys the socket (the client sees a short body against its
 *   Content-Length) and the storage read, and the error is reported.
 * - A client that disconnects aborts the storage read; that is not a
 *   failure, so nothing is reported.
 */
async function sendObject(
    req: Request,
    res: Response,
    download: ObjectDownload,
): Promise<void> {
    if (download.etag) {
        res.setHeader("ETag", download.etag);
        if (req.fresh) return void res.status(304).end();
    }
    const headers = () => {
        res.setHeader("Content-Type", download.contentType);
        res.setHeader("Content-Length", String(download.size));
        res.setHeader(
            "Content-Disposition",
            buildContentDisposition("attachment", download.filename),
        );
    };
    if (req.method === "HEAD") {
        headers();
        return void res.end();
    }

    const clientGone = new AbortController();
    res.once("close", () => {
        if (!res.writableFinished) clientGone.abort();
    });
    let body;
    try {
        body = await download.open(clientGone.signal);
    } catch (error) {
        // The error answer is JSON, not this object: drop its validator.
        res.removeHeader("ETag");
        throw error;
    }
    headers();
    try {
        await pipeline(body, res);
    } catch (error) {
        if (error instanceof StorageOperationError) throw error;
        // Anything else is the client going away mid-transfer (premature
        // close, EPIPE): the pipeline has already released the storage read.
    }
}

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
    await sendObject(req, res, result.data);
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
    await sendObject(req, res, result.download);
}));

downloadsRouter.use(routerErrorHandler("[downloads]"));
