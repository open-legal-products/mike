import type { TabularCell, TabularReviewRow } from "../shared/types";

/**
 * What removing a set of rows takes out of a review, with row membership
 * answered by one Set: the optimistic filters run over every row and every
 * cell, so an Array.includes per item would cost rows × removed and
 * cells × removed instead of one pass each.
 */
export function reviewRowRemoval(rowIds: readonly string[]) {
    const removed = new Set(rowIds);
    return {
        documentIds: (rows: readonly TabularReviewRow[]) =>
            new Set(
                rows
                    .filter((row) => removed.has(row.id))
                    .flatMap((row) => row.source_document_ids),
            ),
        keepsRow: (row: Pick<TabularReviewRow, "id">) => !removed.has(row.id),
        keepsCell: (cell: Pick<TabularCell, "row_id">) =>
            !removed.has(cell.row_id),
        cellIds: (cells: readonly TabularCell[]) =>
            cells
                .filter((cell) => removed.has(cell.row_id))
                .map((cell) => cell.id),
    };
}
