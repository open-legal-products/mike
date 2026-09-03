// Business logic + data-access for the downloads module.
//
// Service layer behind downloads.routes.ts. Takes an explicit Supabase client
// (`db`) plus request-derived primitives, resolves a signed download token to
// the bytes it grants access to, and RETURNS a typed result. It never touches
// req/res — the route maps the result onto status codes, headers, and body.

import type { Db } from "../../lib/supabase";
import { downloadFile } from "../../lib/storage";
import { verifyDownload } from "../../lib/downloadTokens";
import { ensureDocAccess } from "../../lib/access";
import { contentTypeForDocumentType } from "../../lib/documentTypes";

function contentTypeFor(filename: string): string {
    const suffix = filename.includes(".")
        ? filename.split(".").pop()?.toLowerCase()
        : "";
    return contentTypeForDocumentType(suffix);
}

/**
 * Resolve a signed download token to file bytes, enforcing that the token's
 * storage path is still backed by a live document version the caller can
 * access. Every failure after token verification collapses to "not_found" so
 * a valid-looking token cannot be used to probe for foreign files.
 */
export async function resolveTokenDownload(
    db: Db,
    args: { token: string; userId: string; userEmail: string | undefined },
): Promise<
    | { ok: true; bytes: Buffer; contentType: string; filename: string }
    | { ok: false; kind: "invalid_link" | "not_found" }
> {
    const info = verifyDownload(args.token);
    if (!info) return { ok: false, kind: "invalid_link" };

    const { data: version } = await db
        .from("document_versions")
        .select("id, document_id")
        .eq("storage_path", info.path)
        .is("deleted_at", null)
        .maybeSingle();
    if (!version) return { ok: false, kind: "not_found" };

    const { data: doc } = await db
        .from("documents")
        .select("id, user_id, project_id, workflow_id")
        .eq("id", (version as { document_id: string }).document_id)
        .single();
    if (!doc) return { ok: false, kind: "not_found" };

    const access = await ensureDocAccess(doc, args.userId, args.userEmail, db);
    if (!access.ok) return { ok: false, kind: "not_found" };

    const raw = await downloadFile(info.path);
    if (!raw) return { ok: false, kind: "not_found" };

    return {
        ok: true,
        bytes: Buffer.from(raw),
        contentType: contentTypeFor(info.filename),
        filename: info.filename,
    };
}
