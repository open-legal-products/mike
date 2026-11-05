import type { Db } from "./supabase";

export type VersionTextState = { revision: string; text: string | null; textlessPageCount: number };
/** Trusted internal read: caller must authorize the document before calling.
 * Join through the version so deleted, replaced and cross-document text can
 * never be mistaken for a ready cache entry. Null text means cache miss.
 */
export async function loadVersionTextState(db: Db, documentId: string, versionId: string, storagePath?: string): Promise<VersionTextState | null> {
    let query = db.from("document_versions")
        .select("text_revision,document_version_texts(extractor_version,source_revision,status,text_content,textless_page_count)")
        .eq("id", versionId).eq("document_id", documentId).is("deleted_at", null);
    if (storagePath) query = query.eq("storage_path", storagePath);
    const { data, error } = await query.maybeSingle();
    if (error || !data || typeof data.text_revision !== "string") return null;
    const joined = data.document_version_texts;
    const text = (Array.isArray(joined) ? joined[0] : joined) as {
        extractor_version?: number; source_revision?: string; status?: string; text_content?: string | null; textless_page_count?: number | null;
    } | null;
    return {
        revision: data.text_revision,
        // Match the current index reader (find_document_text); older extractor
        // output is a miss even when the source bytes have not changed.
        text: text?.extractor_version === 1 && text.status === "ready" && text.source_revision === data.text_revision && typeof text.text_content === "string"
            ? text.text_content : null,
        textlessPageCount: text?.textless_page_count ?? 0,
    };
}

export function cachedTextForModel(state: VersionTextState): string {
    const notice = state.textlessPageCount
        ? `[${state.textlessPageCount} page(s) have no text layer and need OCR. Search coverage is incomplete.]\n\n` : "";
    return notice + (state.text ?? "");
}
