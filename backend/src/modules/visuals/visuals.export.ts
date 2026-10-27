// Visuals as static files: PDF through the sandbox's Chromium, and
// Word content read from the page block by block. The authorized load and
// the render live in lib/visuals/render.ts, which the chat engine shares;
// the viewer and the HTML download use the documents module.

import { filterAccessibleDocumentIds } from "../../lib/access";
import { can } from "../../lib/permissions";
import { sandboxCapabilities } from "../../lib/sandbox";
import { failure, internalFailure, ok, type ServiceResult } from "../../lib/serviceResult";
import type { Db } from "../../lib/supabase";
import { loadVisual, renderLoadedVisualBlocks, type VisualTarget } from "../../lib/visuals/render";
import { buildVisualDocx, persistGeneratedFile } from "../chat/chat.service";

export { exportVisual } from "../../lib/visuals/render";

export async function createDocxFromVisual(
    db: Db,
    target: VisualTarget,
): Promise<ServiceResult<{ document_id: string; version_id: string; filename: string }>> {
    const loaded = await loadVisual(db, target);
    if (!loaded.ok) return loaded;
    const { source, projectId, orgId, projectRole, isCreator } = loaded.data;
    if (projectId && !can(projectRole, "content.edit")) {
        return failure("forbidden", "You do not have permission to add documents to this project.");
    }
    const rendered = await renderLoadedVisualBlocks(loaded.data);
    if (!rendered.ok) return rendered;
    const built = await buildVisualDocx(rendered.data.blocks);
    if ("error" in built) return internalFailure(new Error(built.error));
    const result = await persistGeneratedFile({
        title: source.title,
        extension: "docx",
        buffer: built.buffer,
        userId: target.userId,
        db,
        projectId,
        // A shared library visual is copied into the caller's own library.
        orgId: projectId || isCreator ? orgId : null,
    });
    if ("error" in result || !result.document_id || !result.version_id) {
        return internalFailure(new Error("docx from visual was not saved"));
    }
    return ok({ document_id: result.document_id, version_id: result.version_id, filename: result.filename });
}

/** The same Word content as bytes, for inserting into an open document. */
export async function visualDocx(db: Db, target: VisualTarget): Promise<ServiceResult<{ bytes: Buffer; filename: string }>> {
    const loaded = await loadVisual(db, target);
    if (!loaded.ok) return loaded;
    const rendered = await renderLoadedVisualBlocks(loaded.data);
    if (!rendered.ok) return rendered;
    const built = await buildVisualDocx(rendered.data.blocks, { forInsert: true });
    if ("error" in built) return internalFailure(new Error(built.error));
    return ok({ bytes: built.buffer, filename: loaded.data.filename.replace(/\.html$/i, "") + ".docx" });
}

export async function visualExportCapabilities(): Promise<{ pdf: boolean; docx: boolean }> {
    const { render } = await sandboxCapabilities();
    return { pdf: render, docx: render };
}

/** When the visual was made and whether any source has moved on since. */
export async function visualSnapshot(
    db: Db,
    target: VisualTarget,
): Promise<ServiceResult<{ created_at: string | null; sources: { document_id: string; filename: string; stale: boolean }[] }>> {
    const loaded = await loadVisual(db, target);
    if (!loaded.ok) return loaded;
    const { createdAt, sources } = loaded.data.source;
    const ids = await filterAccessibleDocumentIds(
        sources.map((s) => s.document_id).filter(Boolean),
        target.userId,
        target.userEmail,
        db,
    );
    const current = new Map<string, string | null>();
    if (ids.length) {
        const { data, error } = await db.from("documents").select("id, current_version_id").in("id", ids);
        if (error) return internalFailure(error);
        for (const row of data ?? []) current.set(row.id as string, (row.current_version_id as string | null) ?? null);
    }
    return ok({
        created_at: createdAt || null,
        sources: sources.map((s) => ({
            document_id: s.document_id,
            filename: s.filename,
            stale: !!s.version_id && current.has(s.document_id) && current.get(s.document_id) !== s.version_id,
        })),
    });
}
