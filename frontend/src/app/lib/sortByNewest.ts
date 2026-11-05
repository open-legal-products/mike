/**
 * `items` newest first, with each item's time computed once. A comparator
 * that calls `Date.parse` re-parses both sides on every comparison, about
 * 2·n·log n parses per sort; parsing once first makes it n.
 * Equal times fall back to `tieBreak`, then to input order (sort is stable).
 */
export function sortByNewest<T>(
    items: readonly T[],
    timeOf: (item: T) => number,
    tieBreak?: (left: T, right: T) => number,
): T[] {
    return items
        .map((item) => ({ item, time: timeOf(item) }))
        .sort(
            (left, right) =>
                right.time - left.time ||
                (tieBreak ? tieBreak(left.item, right.item) : 0),
        )
        .map(({ item }) => item);
}

/** A timestamp string as epoch milliseconds, 0 when missing or invalid. */
export function parsedTime(value: string | null | undefined): number {
    return Date.parse(value ?? "") || 0;
}
