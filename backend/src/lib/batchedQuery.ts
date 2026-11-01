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
 */

export const ID_FILTER_BATCH_SIZE = 50;
/**
 * Must not exceed the gateway's max_rows (1000 in supabase/config.toml): a
 * page shorter than this ends the loop, so a deployment that lowers max_rows
 * below it must lower this too. (loadProjectDirectoryChildren instead reads
 * until an empty page, trading one extra round trip for cap-independence.)
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
 * with `.limit(limit)` — preferred — or, for a composite key PostgREST
 * cannot express as one comparison, `.range(offset, offset + limit - 1)`.
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
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
    after = batch[batch.length - 1];
  }
  throw new BatchedQueryError(label, new Error("page limit exceeded"));
}
