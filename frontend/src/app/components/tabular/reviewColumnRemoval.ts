import type { ColumnConfig, TabularCell } from "../shared/types";

/**
 * Taking columns back out of a review (an add-column save that failed),
 * with column membership answered by one Set: the cell filter runs over the
 * whole grid, so a `some` over the removed columns per cell would cost
 * cells × removed columns.
 */
export function reviewColumnRemoval(columnIndexes: readonly number[]) {
    const removed = new Set(columnIndexes);
    return {
        keepsColumn: (column: Pick<ColumnConfig, "index">) =>
            !removed.has(column.index),
        keepsCell: (cell: Pick<TabularCell, "column_index">) =>
            !removed.has(cell.column_index),
    };
}
