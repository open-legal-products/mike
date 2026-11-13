import { once } from "node:events";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";

/**
 * Stream `source` into an HTTP response; one call per response.
 *
 * Not `pipeline(source, res)`: that puts 7 'close' listeners on `res`, and
 * Sentry's http integration has already put 4 on every response, so each
 * streamed download went one over Node's default limit of 10 and raised a
 * MaxListenersExceededWarning (MIKE-BACKEND-5F). This adds one 'close'
 * listener and keeps what the routes relied on from `pipeline`:
 *
 * - backpressure: a slow client pauses the read from object storage;
 * - a client that disconnects destroys `source` and rejects, whether the
 *   helper is waiting on the socket to drain or on a stalled source;
 * - a `source` error rejects. If bytes are already on the wire the response
 *   is destroyed, so the client sees a broken download rather than a short
 *   one that looks complete. If nothing was sent, the response is left
 *   usable so the caller can still answer with an error status.
 *
 * `source` may be a legacy stream with no async iterator (JSZip's
 * `generateNodeStream`); it is wrapped so both kinds are read the same way.
 */
export async function pipeToResponse(
  source: Readable,
  res: ServerResponse,
): Promise<void> {
  const wrapped = typeof source[Symbol.asyncIterator] !== "function";
  const chunks = wrapped ? new Readable().wrap(source) : source;
  const destroySource = () => {
    chunks.destroy();
    // wrap() does not forward destroy to the legacy stream it reads from.
    if (wrapped) source.destroy();
  };
  const closed = new AbortController();
  const onClose = () => {
    // The 'close' after 'finish' is a completed response, not a disconnect.
    if (res.writableFinished) return;
    closed.abort();
    // The signal only interrupts the wait for 'drain'. A read waiting on a
    // stalled source settles only when the stream is destroyed; otherwise
    // the helper and the storage read would stay pending indefinitely.
    destroySource();
  };
  res.once("close", onClose);
  try {
    for await (const chunk of chunks) {
      if (closed.signal.aborted) break;
      if (!res.write(chunk)) {
        await once(res, "drain", { signal: closed.signal });
      }
    }
    if (closed.signal.aborted) throw prematureClose();
    res.end();
    if (!res.writableFinished) {
      await once(res, "finish", { signal: closed.signal });
    }
  } catch (error) {
    destroySource();
    if (res.headersSent && !res.writableFinished) res.destroy();
    throw closed.signal.aborted ? prematureClose() : error;
  } finally {
    res.off("close", onClose);
  }
}

function prematureClose(): Error {
  return Object.assign(new Error("Response closed before the stream ended"), {
    code: "ERR_STREAM_PREMATURE_CLOSE",
  });
}
