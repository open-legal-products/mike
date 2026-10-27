// worker_threads entry for isolated extraction: run one named parser at a time
// and post the result back. Limits and recycling are the parent's job.

import { parentPort } from "node:worker_threads";
import { EXTRACTION_OPS, type ExtractionOp } from "./ops";

type Request = { op: ExtractionOp; bytes: ArrayBuffer; fileType: string };

parentPort?.on("message", (request: Request) => {
  void (async () => {
    try {
      const result = await EXTRACTION_OPS[request.op](
        request.bytes,
        request.fileType,
      );
      parentPort?.postMessage({ ok: true, result });
    } catch (err) {
      parentPort?.postMessage({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});
