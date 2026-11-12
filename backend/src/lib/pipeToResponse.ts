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
 * - a client that disconnects destroys `source` and rejects;
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
  const chunks =
    Symbol.asyncIterator in source ? source : new Readable().wrap(source);
  const closed = new AbortController();
  const onClose = () => closed.abort();
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
    // Leaving the loop early has already destroyed the stream being read.
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
