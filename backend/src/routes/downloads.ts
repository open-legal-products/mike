import { Router, type RequestHandler } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import {
    buildContentDisposition,
    discardBlob,
    downloadFile,
    writeBlobFromStream,
} from "../lib/storage";
import {
    verifyDownload,
    verifyBlobToken,
    verifyBlobUploadToken,
} from "../lib/downloadTokens";
import { ensureDocAccess } from "../lib/access";
import { contentTypeForDocumentType } from "../lib/documentTypes";

export const downloadsRouter = Router();

function contentTypeFor(filename: string): string {
    const suffix = filename.includes(".")
        ? filename.split(".").pop()?.toLowerCase()
        : "";
    return contentTypeForDocumentType(suffix);
}

// GET /download/signed/:token — the filesystem storage driver's presigned
// URL. Deliberately unauthenticated, exactly like the S3 presigned URLs it
// replaces: the browser reaches it through a bare <a> click or fetch with no
// Authorization header. The token IS the authorization — an expiring HMAC
// capability minted by an authenticated route (documents /url, workflow
// references) AFTER its own access check, scoped to one object. Registered
// before /:token so Express doesn't swallow it with the pattern below.
downloadsRouter.get("/signed/:token", async (req, res) => {
    const info = verifyBlobToken(req.params.token);
    if (!info)
        return void res.status(404).json({ detail: "Invalid or expired link" });

    const raw = await downloadFile(info.path);
    if (!raw)
        return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    res.send(Buffer.from(raw));
});

/**
 * PUT /download/signed/:token — the filesystem storage driver's stand-in for a
 * presigned S3 `PUT`, and the write half of the route above.
 *
 * Unauthenticated for the same reason the GET is: the browser sends this PUT
 * straight from the upload-session flow with no Authorization header, exactly
 * as it would to S3. The token is the authorization — minted by
 * `/upload-sessions` after its own access check, scoped to one staging key.
 *
 * The declared content type and byte count are inside the signature, so an
 * oversized or mistyped body is rejected and the partial file removed, which
 * is how the S3 URL behaves (S3 fails signature validation on a Content-Length
 * that differs from the signed one).
 *
 * Exported rather than registered on `downloadsRouter` because it must be
 * mounted ahead of the global JSON body parser: the body is streamed to disk,
 * never buffered, and a `.json` upload would otherwise be eaten by the parser.
 */
export const blobUploadHandler: RequestHandler<{ token: string }> = async (
    req,
    res,
) => {
    const info = verifyBlobUploadToken(req.params.token);
    if (!info)
        return void res
            .status(403)
            .json({ detail: "Invalid or expired upload link" });

    const declaredType = String(req.headers["content-type"] ?? "")
        .split(";")[0]
        .trim();
    if (declaredType && declaredType !== info.contentType)
        return void res
            .status(400)
            .json({ detail: "Upload content type does not match the link" });

    try {
        const written = await writeBlobFromStream(info.path, req);
        if (written !== info.sizeBytes) {
            await discardBlob(info.path);
            return void res
                .status(400)
                .json({ detail: "Upload size does not match the link" });
        }
    } catch {
        await discardBlob(info.path);
        return void res.status(500).json({ detail: "Upload failed" });
    }
    res.status(200).json({ ok: true });
};

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const info = verifyDownload(req.params.token);
    if (!info) return void res.status(404).json({ detail: "Invalid link" });

    const db = createServerSupabase();
    let version: {
        id: string;
        document_id: string;
    } | null = null;

    const { data: byStoragePath } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", info.path)
        .is("deleted_at", null)
        .maybeSingle();
    if (byStoragePath) {
        version = byStoragePath as { id: string; document_id: string };
    }

    if (!version)
        return void res.status(404).json({ detail: "File not found" });

    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id, org_id, workflow_id")
        .eq("id", version.document_id)
        .single();
    if (!doc) return void res.status(404).json({ detail: "File not found" });

    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

    const raw = await downloadFile(info.path);
    if (!raw) return void res.status(404).json({ detail: "File not found" });

    res.setHeader("Content-Type", contentTypeFor(info.filename));
    res.setHeader(
        "Content-Disposition",
        buildContentDisposition("attachment", info.filename),
    );
    res.send(Buffer.from(raw));
});
