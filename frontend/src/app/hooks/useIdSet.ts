import { useMemo } from "react";

/**
 * A Set view of a selection kept as an id array, rebuilt only when the
 * array changes. Rows ask `has` instead of `includes`, so rendering a table
 * costs rows + selected rather than rows × selected.
 */
export function useIdSet<T>(ids: readonly T[]): ReadonlySet<T> {
    return useMemo(() => new Set(ids), [ids]);
}
