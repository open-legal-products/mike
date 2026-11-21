/**
 * How long a read may wait on object storage before it is abandoned.
 *
 * A stalled read would otherwise pin whoever awaits it: a request handler, or
 * the single background source-loading slot. Buffered reads (downloadFile)
 * apply it to the whole transfer; streamed reads apply it to each wait on the
 * store, so a slow client that is merely applying backpressure is not cut off.
 */
export function storageReadTimeoutMs(): number {
  const value = Number(process.env.STORAGE_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}
