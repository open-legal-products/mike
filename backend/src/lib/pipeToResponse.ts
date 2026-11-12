import type { ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * `pipeline(source, res)` puts 7 'close' listeners on `res` (its destroyer,
 * two end-of-stream watchers, Readable.pipe's own, and the writer's cleanup),
 * and Sentry's http integration has already put 4 on every response. 11 is
 * over Node's default of 10, so every streamed download raised a
 * MaxListenersExceededWarning although nothing leaks: both sets are fixed per
 * response and go away with it. Raising the cap by exactly what the pipeline
 * adds keeps the warning meaningful for a real leak on top of it.
 */
const PIPELINE_CLOSE_LISTENERS = 7;

/** Stream `source` into an HTTP response; one call per response. */
export function pipeToResponse(
  source: Readable,
  res: ServerResponse,
): Promise<void> {
  const max = res.getMaxListeners();
  if (max !== 0) res.setMaxListeners(max + PIPELINE_CLOSE_LISTENERS);
  return pipeline(source, res);
}
