// Row loading for the tabular-review module.
//
// A review's grid is made of ROWS (tabular_review_rows): a row is either one
// document or a folder grouping several source documents. These helpers load
// the rows with their source-document ids resolved, and build the combined
// text a row's extraction runs over. The synchronous SSE route and the async
// extraction worker share this one copy.

import { downloadFile } from "../../lib/storage";
import { attachActiveVersionPaths } from "../../lib/documentVersions";
import { extractDocumentMarkdown } from "./tabular.extract";
import { type Db } from "./tabular.shared";

export type ReviewRow = {
    id: string;
    review_id: string;
    label: string;
    row_type: "document" | "folder";
    folder_id: string | null;
    library_folder_id: string | null;
    document_id: string | null;
    sort_index: number;
    source_document_ids?: string[];
};

export type SourceDocument = {
    id: string;
    filename: string;
    file_type: string | null;
    current_version_id?: string | null;
    project_id?: string | null;
    folder_id?: string | null;
    library_folder_id?: string | null;
};

export async function fetchSourceDocuments(
    db: Db,
    documentIds: string[],
): Promise<SourceDocument[]> {
    if (documentIds.length === 0) return [];
    const { data, error } = await db
        .from("documents")
        .select(
            "id, current_version_id, project_id, folder_id, library_folder_id",
        )
        .in("id", documentIds);
    if (error) throw new Error(error.message);
    const docs = (data ?? []) as (Omit<
        SourceDocument,
        "filename" | "file_type"
    > & {
        filename?: string | null;
        file_type?: string | null;
    })[];
    await attachActiveVersionPaths(db, docs);
    const position = new Map(documentIds.map((id, index) => [id, index]));
    return docs
        .map((doc) => ({
            ...doc,
            filename: doc.filename?.trim() || "Untitled document",
            file_type: doc.file_type ?? null,
        }))
        .sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
}

export async function loadReviewRows(
    db: Db,
    reviewId: string,
): Promise<ReviewRow[]> {
    const { data, error } = await db
        .from("tabular_review_rows")
        .select("*")
        .eq("review_id", reviewId)
        .order("sort_index", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as ReviewRow[];
    if (!rows.length) return rows;
    const { data: sources, error: sourceError } = await db
        .from("tabular_review_row_sources")
        .select("row_id, document_id")
        .in("row_id", rows.map((row) => row.id))
        .order("sort_index", { ascending: true });
    if (sourceError) throw new Error(sourceError.message);
    const byRow = new Map<string, string[]>();
    for (const source of sources ?? []) {
        byRow.set(source.row_id, [
            ...(byRow.get(source.row_id) ?? []),
            source.document_id,
        ]);
    }
    return rows.map((row) => ({
        ...row,
        source_document_ids:
            byRow.get(row.id) ?? (row.document_id ? [row.document_id] : []),
    }));
}

/** Load one row of a review (with its source ids resolved), or null. */
export async function loadReviewRow(
    db: Db,
    reviewId: string,
    rowId: string,
): Promise<ReviewRow | null> {
    const rows = await loadReviewRows(db, reviewId);
    return rows.find((row) => row.id === rowId) ?? null;
}

export async function loadRowDocumentText(
    db: Db,
    row: ReviewRow,
): Promise<string> {
    const sourceIds =
        row.source_document_ids ?? (row.document_id ? [row.document_id] : []);
    const docs = await fetchSourceDocuments(db, sourceIds);
    const sections: string[] = [];
    for (const doc of docs) {
        const storagePath = (doc as SourceDocument & { storage_path?: string })
            .storage_path;
        let markdown = "";
        if (storagePath) {
            const buf = await downloadFile(storagePath);
            if (buf) {
                try {
                    markdown = await extractDocumentMarkdown(
                        buf,
                        doc.file_type,
                    );
                } catch (error) {
                    console.error(
                        `[tabular] extraction error doc=${doc.id}`,
                        error,
                    );
                }
            }
        }
        sections.push(
            `## Source document: ${doc.filename}\nSource document ID: ${doc.id}\n\n${markdown}`,
        );
    }
    return sections.join("\n\n---\n\n");
}
