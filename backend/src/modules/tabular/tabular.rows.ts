// Row loading for the tabular-review module.
//
// A review's grid is made of ROWS (tabular_review_rows): a row is either one
// document or a folder grouping several source documents. These helpers load
// the rows with their source-document ids resolved, and build the combined
// text a row's extraction runs over. The synchronous SSE route and the async
// extraction worker share this one copy.

import { ExtractionBusyError, ExtractionLimitError } from "../../lib/extraction/isolated";
import { downloadFile } from "../../lib/storage";
import { attachActiveVersionPaths } from "../../lib/documentVersions";
import { filterAccessibleDocumentIds } from "../../lib/access";
import { extractDocumentMarkdown } from "./tabular.extract";
import { AppError } from "../../lib/appError";
import { reportError } from "../../lib/observability/sentry";
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

/**
 * Narrow a review's rows to those the CALLER may read. Review access is not
 * document access: a review in project Y can be built from project X's
 * documents, and a Y member without X access must not read X's filenames
 * (row labels) or the text extracted from them (cells). A row is visible only
 * when the caller can read every source document feeding it — the same rule
 * generation applies before extracting. Also returns the readable document
 * ids so callers can filter document metadata with the same verdict.
 */
export async function filterReadableReviewRows(
    db: Db,
    rows: ReviewRow[],
    extraDocumentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
): Promise<{ rows: ReviewRow[]; readableDocumentIds: Set<string> }> {
    const ids = [
        ...new Set([
            ...rows.flatMap((row) => row.source_document_ids ?? []),
            ...extraDocumentIds,
        ]),
    ];
    const readableDocumentIds = new Set(
        await filterAccessibleDocumentIds(ids, userId, userEmail, db),
    );
    return {
        rows: rows.filter((row) =>
            (row.source_document_ids ?? []).every((id) =>
                readableDocumentIds.has(id),
            ),
        ),
        readableDocumentIds,
    };
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
        const ids = byRow.get(source.row_id) ?? [];
        ids.push(source.document_id);
        byRow.set(source.row_id, ids);
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
    const { data, error } = await db
        .from("tabular_review_rows")
        .select("*")
        .eq("review_id", reviewId)
        .eq("id", rowId)
        .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    const row = data as ReviewRow;
    const { data: sources, error: sourceError } = await db
        .from("tabular_review_row_sources")
        .select("document_id")
        .eq("row_id", rowId)
        .order("sort_index", { ascending: true });
    if (sourceError) throw new Error(sourceError.message);
    return {
        ...row,
        source_document_ids: sources?.length
            ? sources.map((source) => source.document_id)
            : row.document_id ? [row.document_id] : [],
    };
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
            try {
                markdown = await extractDocumentMarkdown(
                    () => downloadFile(storagePath),
                    doc.file_type,
                );
            } catch (error) {
                // Do not ask the model to fill cells from a source we refused.
                if (error instanceof ExtractionBusyError || error instanceof ExtractionLimitError) throw error;
                // The row goes on with an empty source section; the
                // parser's or converter's error is the cause, so its
                // class and code say what failed. Logging the reported
                // object keeps the console bridge from filing it twice.
                const failure = new AppError(
                    "extraction.failed",
                    "Tabular source document text extraction failed",
                    { cause: error },
                );
                reportError(failure, { extra: { document_id: doc.id } });
                console.error(
                    `[tabular] extraction error doc=${doc.id}`,
                    failure,
                );
            }
        }
        sections.push(
            `## Source document: ${doc.filename}\nSource document ID: ${doc.id}\n\n${markdown}`,
        );
    }
    return sections.join("\n\n---\n\n");
}
