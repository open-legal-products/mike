import { chunkArray } from "./arrays";

/**
 * Bounded reads and writes over PostgREST.
 *
 * Two limits shape every list query this backend sends:
 *
 * - **URL length.** A `.in("id", ids)` filter is spelled out in the request
 *   URL (`?id=in.(uuid,uuid,...)`), ~37 bytes per UUID. Gateways reject long
 *   request lines (414 / 431) well before a few hundred ids, so an id list is
 *   sent in batches of {@link ID_FILTER_BATCH_SIZE}, the size the access
 *   checks already use.
 * - **max_rows.** PostgREST silently truncates every response to the
 *   configured `max_rows` (1000 in supabase/config.toml) with no error, so an
 *   unpaged read of a large table returns a plausible-looking prefix. A read
 *   that must be complete pages by key until a short page comes back.
 *
 * A failed batch or page is not "no rows": every helper throws (with the
 * PostgREST error as `cause`, never in the message sent to a client) instead
 * of returning a partial list that the caller would act on as if complete.
 *
 * Error convention: these helpers THROW a BatchedQueryError (fixed message,
 * the database error as `cause`). A caller that turns the failure into a
 * result carrying the raw database error (`db_error`, `cells_error`, a
 * service failure) puts {@link queryFailureCause}(error) there, so those
 * results look the same whether the read was batched or not.
 */

export const ID_FILTER_BATCH_SIZE = 50;
/**
 * Rows requested per page: the gateway's max_rows (1000 in
 * supabase/config.toml). A lower cap only makes pages shorter; the page loop
 * reads until an empty page, so nothing is lost either way.
 */
export const ROW_PAGE_SIZE = 1000;
/** Guards a runaway loop (a cursor that does not advance), not a product limit. */
const MAX_PAGES = 10_000;

type RowsResult<T> = { data: T[] | null; error: unknown };
type ErrorResult = { error: unknown };

export class BatchedQueryError extends Error {
  constructor(label: string, cause: unknown) {
    super(`${label} failed`, { cause });
    this.name = "BatchedQueryError";
  }
}

/** Distinct, non-empty ids in first-seen order. */
export function uniqueIds(
  ids: Iterable<string | null | undefined>,
): string[] {
  const seen = new Set<string>();
  for (const id of ids) if (id) seen.add(id);
  return [...seen];
}

/**
 * Run `query` once per batch of distinct ids and concatenate the rows. The
 * callback may return a PostgREST result or an already-complete row list
 * (e.g. from {@link selectAllPages} when one batch can exceed max_rows).
 */
export async function selectInBatches<T>(
  label: string,
  ids: Iterable<string | null | undefined>,
  query: (batch: string[]) => PromiseLike<RowsResult<T> | T[]>,
  batchSize = ID_FILTER_BATCH_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  for (const batch of chunkArray(uniqueIds(ids), batchSize)) {
    const result = await query(batch);
    if (Array.isArray(result)) {
      rows.push(...result);
      continue;
    }
    if (result.error) throw new BatchedQueryError(label, result.error);
    rows.push(...(result.data ?? []));
  }
  return rows;
}

/** Run a row-less mutation (delete/update) once per batch of distinct ids. */
export async function mutateInBatches(
  label: string,
  ids: Iterable<string | null | undefined>,
  mutate: (batch: string[]) => PromiseLike<ErrorResult>,
  batchSize = ID_FILTER_BATCH_SIZE,
): Promise<void> {
  for (const batch of chunkArray(uniqueIds(ids), batchSize)) {
    const { error } = await mutate(batch);
    if (error) throw new BatchedQueryError(label, error);
  }
}

/**
 * Read every row of a query in pages. `page(after, limit, offset)` must order
 * by a unique key and either apply the keyset cursor (rows strictly after
 * `after`, the last row of the previous page; `null` for the first page)
 * with `.limit(limit)` — preferred, see {@link selectAllByKey} — or, for a
 * composite key PostgREST cannot express as one comparison,
 * `.range(offset, offset + limit - 1)`.
 *
 * The loop ends on an EMPTY page, not on a short one: a gateway configured
 * with a lower max_rows than `pageSize` returns short pages that are not the
 * end, and stopping there would recreate the silent truncation this helper
 * exists to prevent. The price is one extra (empty, indexed) round trip.
 */
export async function selectAllPages<T>(
  label: string,
  page: (after: T | null, limit: number, offset: number) => PromiseLike<RowsResult<T>>,
  pageSize = ROW_PAGE_SIZE,
): Promise<T[]> {
  const rows: T[] = [];
  let after: T | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const { data, error } = await page(after, pageSize, rows.length);
    if (error) throw new BatchedQueryError(label, error);
    const batch = data ?? [];
    if (batch.length === 0) return rows;
    rows.push(...batch);
    after = batch[batch.length - 1];
  }
  throw new BatchedQueryError(label, new Error("page limit exceeded"));
}

/** The chainable part of a PostgREST filter builder that keyset paging needs. */
type KeysetQuery<T> = PromiseLike<RowsResult<T>> & {
  order(column: string, options: { ascending: boolean }): KeysetQuery<T>;
  limit(count: number): KeysetQuery<T>;
  gt(column: string, value: unknown): KeysetQuery<T>;
};

/**
 * Every row of a filtered query, keyset-paged on a unique `key` (the primary
 * key unless the filter makes another column unique). `build` returns the
 * filtered builder — `db.from(t).select(cols).eq(…)` — without order or
 * limit; this adds `.order(key).limit(n)` and `.gt(key, last[key])`.
 * Rows come back in key order; callers that promised another order sort.
 */
export function selectAllByKey<T extends Record<string, unknown>>(
  label: string,
  build: () => unknown,
  key = "id",
  pageSize = ROW_PAGE_SIZE,
): Promise<T[]> {
  return selectAllPages<T>(
    label,
    async (after, limit) => {
      const query = (build() as KeysetQuery<T>).order(key, { ascending: true }).limit(limit);
      const page = await (after ? query.gt(key, after[key]) : query);
      // A page that does not move past the cursor (a builder that dropped
      // the `.gt`) would repeat forever; treat it as the end, not as rows.
      const rows = page.data ?? [];
      if (after && rows.length && rows[rows.length - 1][key] === after[key])
        return { data: [], error: page.error };
      return page;
    },
    pageSize,
  );
}

/** The database error behind a batched-query failure, for result types that carry one. */
export function queryFailureCause(error: unknown): unknown {
  return error instanceof BatchedQueryError ? error.cause : error;
}
