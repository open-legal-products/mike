import { Worker } from "node:worker_threads";
import path from "node:path";
import { DocxDiffError, type DocxDiffEngine } from "./types";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export const docxodusDiffEngine: DocxDiffEngine = {
  id: "docxodus",
  maxInputBytes: MAX_INPUT_BYTES,
  async compare(original, revised, options) {
    if (Math.max(original.byteLength, revised.byteLength) > MAX_INPUT_BYTES)
      throw new DocxDiffError("Comparison input exceeds the Docxodus size limit.");
    const extension = __filename.endsWith(".ts") ? ".mts" : ".mjs";
    const worker = new Worker(path.join(__dirname, `docxodus.worker${extension}`), {
      workerData: { original, revised, options },
      execArgv: [],
      // The engine writes raw parser diagnostics. Only its typed reply or exception leaves the worker.
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DocxDiffError("Comparison exceeded the time limit.")), 60_000);
        worker.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Comparison worker exited before replying."));
        });
        worker.once("error", reject);
        worker.once("message", (reply: Uint8Array | { error: Error }) => {
          if ("error" in reply) reject(new DocxDiffError("The documents could not be compared.", { cause: reply.error }));
          else resolve(Buffer.from(reply.buffer, reply.byteOffset, reply.byteLength));
        });
      });
    } finally {
      await worker.terminate();
    }
  },
};
