type Identified = { id: string };

/**
 * The incoming items whose id is not already present (nor repeated earlier
 * in `incoming`), in incoming order. Existing ids are hashed once, so this
 * costs existing + incoming instead of a nested `some` per incoming item.
 */
export function missingById<T extends Identified>(
    existing: readonly Identified[],
    incoming: readonly T[],
): T[] {
    const known = new Set(existing.map((item) => item.id));
    return incoming.filter((item) => {
        if (known.has(item.id)) return false;
        known.add(item.id);
        return true;
    });
}

/** `existing` followed by `missingById`; the same array when nothing is new. */
export function appendMissingById<T extends Identified>(
    existing: T[],
    incoming: readonly T[],
): T[] {
    const missing = missingById(existing, incoming);
    return missing.length === 0 ? existing : [...existing, ...missing];
}

/** One id lookup per list, built once per change instead of a `find` per id. */
export function indexById<T extends Identified>(
    items: readonly T[],
): Map<string, T> {
    return new Map(items.map((item) => [item.id, item]));
}
