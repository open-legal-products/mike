// Document parsing in a dedicated worker thread, with a time and a memory
// limit.
//
// The parsers (SheetJS, fast-xml-parser, mammoth, pdfjs) do long stretches of
// synchronous work on the whole file. On the thread that calls them, nothing
// else runs until they finish: a 65 MB workbook once froze the background
// thread for hours, and every upload and queued job with it, until the process
// ran out of memory. Here the parse runs on its own thread instead. A file that
// runs past the timeout or the memory limit is stopped and reported as too
// large, and nothing else on the calling thread notices.
//
// One worker per calling thread, one file at a time: on a small container,
// parallel parses only split the same CPU and multiply peak memory.

import path from "node:path";
import { Worker } from "node:worker_threads";
import { EXTRACTION_OPS, type ExtractionOp, type ExtractionOps } from "./ops";

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Larger files are refused before download: they cannot parse in time. */
export const EXTRACTION_MAX_BYTES = 150 * 1024 * 1024;
// Read on use, so a changed setting applies to the next file or worker.
const timeoutMs = () => envNumber("EXTRACTION_TIMEOUT_MS", 3 * 60 * 1000);
const maxMemoryMb = () => envNumber("EXTRACTION_MAX_MEMORY_MB", 1024);
// A fresh worker now and then returns whatever memory the parsers held on to.
const RECYCLE_AFTER_FILES = 200;
const IDLE_SHUTDOWN_MS = 60 * 1000;

/** The file hit a limit. Retrying cannot help, so callers treat it as final. */
export class ExtractionLimitError extends Error {
  constructor(reason: string) {
    super(`document_too_large: ${reason}`);
    this.name = "ExtractionLimitError";
  }
}

type Result<K extends ExtractionOp> = Awaited<ReturnType<ExtractionOps[K]>>;

type Task = {
  op: ExtractionOp;
  bytes: ArrayBuffer;
  fileType: string;
  interactive: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type Reply = { ok: true; result: unknown } | { ok: false; message: string };

const queue: Task[] = [];
let worker: Worker | null = null;
let current: Task | null = null;
let timeout: ReturnType<typeof setTimeout> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let filesOnWorker = 0;

function spawn(): Worker {
  // In dev (tsx) and tests this file is .ts and so is the entry, loaded
  // through tsx's CJS require hook; in prod both are compiled .js in dist.
  const isTs = __filename.endsWith(".ts");
  const memoryMb = maxMemoryMb();
  const w = new Worker(path.join(__dirname, isTs ? "thread.ts" : "thread.js"), {
    execArgv: isTs ? ["--require", "tsx/cjs"] : [],
    resourceLimits: { maxOldGenerationSizeMb: memoryMb },
  });
  // Never the reason a process stays up.
  w.unref();
  w.on("message", (reply: Reply) => {
    if (w !== worker) return;
    filesOnWorker += 1;
    if (filesOnWorker >= RECYCLE_AFTER_FILES) retire(w);
    settle(reply.ok ? { value: reply.result } : { error: new Error(reply.message) });
  });
  w.on("error", (err: Error & { code?: string }) => {
    if (w !== worker) return;
    worker = null;
    settle({
      error:
        err.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new ExtractionLimitError(`needed more than ${memoryMb} MB`)
          : err,
    });
  });
  w.on("exit", () => {
    if (w !== worker) return;
    worker = null;
    settle({ error: new Error("extraction worker exited") });
  });
  return w;
}

function retire(w: Worker): void {
  if (worker === w) worker = null;
  filesOnWorker = 0;
  void w.terminate();
}

function settle(outcome: { value: unknown } | { error: Error }): void {
  const task = current;
  if (!task) return;
  current = null;
  if (timeout) clearTimeout(timeout);
  timeout = null;
  if ("error" in outcome) task.reject(outcome.error);
  else task.resolve(outcome.value);
  pump();
}

function pump(): void {
  if (current) return;
  const task = queue.shift();
  if (!task) {
    scheduleIdleShutdown();
    return;
  }
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const w = worker ?? (worker = spawn());
  current = task;
  // The clock starts when the file does, not while it waits its turn.
  const limitMs = timeoutMs();
  timeout = setTimeout(() => {
    retire(w);
    settle({
      error: new ExtractionLimitError(`took longer than ${limitMs / 1000}s`),
    });
  }, limitMs);
  timeout.unref();
  w.postMessage({ op: task.op, bytes: task.bytes, fileType: task.fileType });
}

function scheduleIdleShutdown(): void {
  const w = worker;
  if (!w || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (worker === w && !current) retire(w);
  }, IDLE_SHUTDOWN_MS);
  idleTimer.unref();
}

/**
 * Run a parser from ops.ts on its own thread. Interactive callers (a user
 * waiting on a chat or a review) go ahead of queued background work. Rejects
 * with ExtractionLimitError when the file is too big, too slow, or needs too
 * much memory; any other rejection is the parser's own error.
 */
export async function runIsolatedExtraction<K extends ExtractionOp>(
  op: K,
  bytes: ArrayBuffer,
  options: { fileType?: string; interactive?: boolean } = {},
): Promise<Result<K>> {
  if (bytes.byteLength > EXTRACTION_MAX_BYTES) {
    throw new ExtractionLimitError(
      `larger than ${EXTRACTION_MAX_BYTES / 1024 / 1024} MB`,
    );
  }
  const fileType = options.fileType ?? "";
  // Escape hatch for platforms without worker_threads, and for unit tests,
  // whose module mocks cannot reach into a worker.
  if (process.env.EXTRACTION_ISOLATION === "off") {
    return (await EXTRACTION_OPS[op](bytes, fileType)) as Result<K>;
  }
  return new Promise<Result<K>>((resolve, reject) => {
    const task: Task = {
      op,
      bytes,
      fileType,
      interactive: options.interactive === true,
      resolve: resolve as (value: unknown) => void,
      reject,
    };
    const firstBackground = task.interactive
      ? queue.findIndex((queued) => !queued.interactive)
      : -1;
    if (firstBackground === -1) queue.push(task);
    else queue.splice(firstBackground, 0, task);
    pump();
  });
}
