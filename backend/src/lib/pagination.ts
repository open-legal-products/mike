export interface PaginationParams {
    limit: number;
    offset: number;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function parsePaginationQuery(value: Record<string, unknown>): PaginationParams {
    const requestedLimit = Number.parseInt(String(value.limit ?? ""), 10);
    const requestedOffset = Number.parseInt(String(value.offset ?? ""), 10);

    const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), MAX_LIMIT)
        : DEFAULT_LIMIT;
    const offset = Number.isFinite(requestedOffset) && requestedOffset > 0
        ? requestedOffset
        : 0;

    return { limit, offset };
}

/** PostgREST returns at most this many rows per request (`max_rows`). */
export const DB_PAGE_SIZE = 1000;

/**
 * Read every row of a query that may exceed the PostgREST row cap, one
 * range at a time, until a short page ends it. `page(from, to)` must apply a
 * stable `.order(...)` before `.range(from, to)`, or rows can repeat or go
 * missing between pages.
 */
export async function fetchAllPages<T>(
    page: (
        from: number,
        to: number,
    ) => PromiseLike<{ data: T[] | null; error: unknown }>,
    pageSize = DB_PAGE_SIZE,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: unknown }> {
    const rows: T[] = [];
    for (let from = 0; ; from += pageSize) {
        const { data, error } = await page(from, from + pageSize - 1);
        if (error) return { ok: false, error };
        const batch = data ?? [];
        rows.push(...batch);
        if (batch.length < pageSize) return { ok: true, rows };
    }
}
