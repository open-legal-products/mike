export function restoreOptimisticallyDeletedRows<T extends { id: string }>(
    currentRows: T[],
    snapshotRows: T[],
    failedIds: readonly string[],
): T[] {
    if (failedIds.length === 0) return currentRows;

    const failed = new Set(failedIds);
    const currentById = new Map(currentRows.map((row) => [row.id, row]));
    const restored: T[] = [];
    const included = new Set<string>();

    for (const snapshotRow of snapshotRows) {
        const currentRow = currentById.get(snapshotRow.id);
        if (currentRow) {
            restored.push(currentRow);
            included.add(currentRow.id);
        } else if (failed.has(snapshotRow.id)) {
            restored.push(snapshotRow);
            included.add(snapshotRow.id);
        }
    }

    for (const currentRow of currentRows) {
        if (included.has(currentRow.id)) continue;
        restored.push(currentRow);
    }

    return restored;
}
