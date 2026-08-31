import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { buildContentDisposition, downloadFile } from "../lib/storage";
import { verifyDownload, verifyBlobToken } from "../lib/downloadTokens";
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

// GET /download/:token
downloadsRouter.get("/:token", requireAuth, async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const info = verifyDownload(req.params.token);
    if (!info)
        return void res.status(404).json({ detail: "Invalid link" });

    const db = createServerSupabase();
    let version:
        | {
              id: string;
              document_id: string;
          }
        | null = null;

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
        .select("id, user_id, project_id")
        .eq("id", version.document_id)
        .single();
    if (!doc)
        return void res.status(404).json({ detail: "File not found" });

    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (!access.ok)
        return void res.status(404).json({ detail: "File not found" });

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
