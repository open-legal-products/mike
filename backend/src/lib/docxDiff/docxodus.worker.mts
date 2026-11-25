import { parentPort, workerData } from "node:worker_threads";
import type { DocxDiffOptions } from "./types.js";

// A fresh worker owns the WASM heap for the lifetime of one comparison.
async function compare() {
  const { original, revised, options } = workerData as {
    original: Uint8Array; revised: Uint8Array; options: DocxDiffOptions;
  };
  const core = await import("docxodus/core");
  await core.initialize();
  try {
    const bytes = await core.docxDiffCompare(original, revised, {
      authorForRevisions: options.author,
      dateTimeForRevisions: options.date.toISOString().replace(/\.\d{3}Z$/, "Z"),
      preAcceptInputRevisions: true,
    });
    parentPort!.postMessage(bytes);
  } catch (error) {
    // Docxodus returns an empty result for inputs it cannot compare. Runtime
    // and initialization faults must reach the API's normal error reporting.
    if (!(error instanceof Error) || error.message !== "DocxDiff comparison failed - empty result") throw error;
    parentPort!.postMessage({ error });
  }
}

void compare();
