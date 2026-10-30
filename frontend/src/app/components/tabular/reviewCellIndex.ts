import type { TabularCell } from "../shared/types";

/** A row/column lookup built once, rather than a full cell search per grid slot. */
export function indexReviewCells(cells: readonly TabularCell[]): Map<string, Map<number, TabularCell>> {
    const rows = new Map<string, Map<number, TabularCell>>();
    for (const cell of cells) {
        let columns = rows.get(cell.row_id);
        if (!columns) rows.set(cell.row_id, columns = new Map());
        // Match Array.find if an optimistic cell briefly duplicates a persisted one.
        if (!columns.has(cell.column_index)) columns.set(cell.column_index, cell);
    }
    return rows;
}
