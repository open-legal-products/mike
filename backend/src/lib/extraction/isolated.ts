// One parser slot per calling thread. Queue coordination remains responsive;
// a reusable child process keeps parsers warm behind an OS memory boundary.
import path from "node:path";
import type { Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ExtractionOp, ExtractionOps } from "./ops";
import { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError, extractionMemoryMb, extractionTimeoutMs } from "./limits";

export { EXTRACTION_MAX_BYTES, ExtractionBusyError, ExtractionLimitError } from "./limits";

type Result<K extends ExtractionOp> = Awaited<ReturnType<ExtractionOps[K]>>;
export type ExtractInSlot = <K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options?: { fileType?: string }) => Promise<Result<K>>;
type Reply = { ok: true; result: unknown } | { ok: false; limited: boolean; message: string };

/** Hard OS memory boundary on Linux, including native buffers. Fail closed if
 * prlimit is unavailable. Other platforms retain process/heap and input/output
 * bounds, but do not claim the Linux OS-memory guarantee.
 */
export function extractionCommand(entry: string): { command: string; args: string[] } {
  const memoryMb = extractionMemoryMb();
  const nodeArgs = [
    "--disable-wasm-trap-handler",
    `--max-old-space-size=${memoryMb}`,
    ...(entry.endsWith(".ts") ? ["--require", require.resolve("tsx/cjs")] : []),
    entry,
  ];
  if (process.platform === "linux") {
    const bytes = memoryMb * 1024 * 1024;
    // Writable heap/native allocations share the data limit. V8 also reserves
    // address space for code (and the TS loader in dev); bound that separately.
    const addressBytes = bytes + 1024 ** 3;
    return { command: "prlimit", args: [`--data=${bytes}:${bytes}`, `--as=${addressBytes}:${addressBytes}`, "--core=0:0", "--", process.execPath, ...nodeArgs] };
  }
  return { command: process.execPath, args: nodeArgs };
}

function killParser(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => { child.kill("SIGKILL"); });
  } else {
    // Includes LibreOffice descendants, including after the parser has exited.
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

type Parser = {
  child: ChildProcess;
  closed: Promise<void>;
  memoryMb: number;
  started: boolean;
  files: number;
  idle?: ReturnType<typeof setTimeout>;
};
let parser: Parser | null = null;
const RECYCLE_AFTER_FILES = 200;
const IDLE_SHUTDOWN_MS = 60_000;

function retire(p: Parser): void {
  if (parser === p) parser = null;
  clearTimeout(p.idle);
  killParser(p.child);
}

/** Also used at test boundaries so no warm process outlives its configuration. */
export async function stopExtractionProcess(): Promise<void> {
  const p = parser;
  if (p) { retire(p); await p.closed; }
}

function reference(p: Parser, active: boolean): void {
  if (active) {
    p.child.ref(); p.child.channel?.ref();
    (p.child.stderr as Socket | null)?.ref();
  } else {
    p.child.unref(); p.child.channel?.unref();
    (p.child.stderr as Socket | null)?.unref();
  }
}

async function startParser(): Promise<Parser> {
  const entry = path.join(__dirname, __filename.endsWith(".ts") ? "process.ts" : "process.js");
  const { command, args } = extractionCommand(entry);
  const scratch = await mkdtemp(path.join(tmpdir(), "mike-extraction-"));
  // No application credentials or inherited NODE_OPTIONS in the parser.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "SystemRoot", "HOME", "LANG", "SOFFICE_BINARY_PATH", "LIBREOFFICE_BINARY_PATH", "LIBRE_OFFICE_EXE"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.TMPDIR = env.TMP = env.TEMP = scratch;
  // Avoid glibc arena reservations exhausting RLIMIT_AS at low actual usage.
  env.MALLOC_ARENA_MAX = "2";
  const child = spawn(command, args, {
    env, detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
  });
  const p: Parser = { child, closed: Promise.resolve(), memoryMb: extractionMemoryMb(), started: false, files: 0 };
  const onParentExit = () => killParser(child);
  process.once("exit", onParentExit);
  child.once("spawn", () => { p.started = true; });
  // Idle child errors must still retire the process even without a parse listener.
  child.on("error", () => retire(p));
  p.closed = new Promise<void>((resolve, reject) => child.once("close", () => {
    retire(p);
    process.removeListener("exit", onParentExit);
    void rm(scratch, { recursive: true, force: true }).then(resolve, reject);
  }));
  // Idle retirement has no caller awaiting cleanup; active parses do await it.
  void p.closed.catch(() => {});
  return p;
}

async function extractInChild<K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options: { fileType?: string } = {}): Promise<Result<K>> {
  if (bytes.byteLength > EXTRACTION_MAX_BYTES) throw new ExtractionLimitError("source exceeds 150 MB");
  if (process.env.EXTRACTION_ISOLATION === "off") {
    const { EXTRACTION_OPS } = await import("./ops.js");
    return await EXTRACTION_OPS[op](bytes, options.fileType ?? "") as Result<K>;
  }
  if (parser && parser.memoryMb !== extractionMemoryMb()) await stopExtractionProcess();
  const p = parser ?? (parser = await startParser());
  clearTimeout(p.idle);
  reference(p, true);
  const { child } = p;
  return new Promise<Result<K>>((resolve, reject) => {
    let reply: Reply | undefined;
    let failure: Error | undefined;
    let diagnostics = "";
    const timeout = setTimeout(() => {
      failure = new ExtractionLimitError("parser deadline exceeded");
      retire(p);
    }, extractionTimeoutMs());
    const onDiagnostics = (chunk: Buffer) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-8192);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.removeListener("spawn", send);
      child.stderr?.removeListener("data", onDiagnostics);
    };
    const onMessage = (message: Reply) => {
      if (failure) return;
      reply = message;
      if (!reply.ok || ++p.files >= RECYCLE_AFTER_FILES) { retire(p); return; }
      cleanup();
      p.idle = setTimeout(() => retire(p), IDLE_SHUTDOWN_MS);
      p.idle.unref();
      reference(p, false);
      resolve(reply.result as Result<K>);
    };
    const onError = (error: Error) => { failure = error; retire(p); };
    const onClose = (_code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      void p.closed.then(() => {
        if (failure instanceof ExtractionLimitError) reject(failure);
        else if (reply?.ok) resolve(reply.result as Result<K>);
        else if (reply) reject(reply.limited ? new ExtractionLimitError(reply.message) : new Error(reply.message));
        else if (signal === "SIGABRT" || /out of memory|allocation failed|cannot allocate memory|failed to map segment|ENOMEM/i.test(diagnostics)) {
          reject(new ExtractionLimitError("parser memory budget exceeded"));
        } else reject(failure ?? new Error("extraction process exited without a result"));
      }, reject);
    };
    const send = () => child.send({ op, bytes, fileType: options.fileType ?? "" }, (error) => {
      if (error && !reply && !failure) onError(error);
    });
    child.stderr?.on("data", onDiagnostics);
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
    if (p.started) send(); else child.once("spawn", send);
  });
}

const MAX_WAITERS = 8;

// Separate download concurrency from parser concurrency. A slow storage read
// must not stop another already-downloaded tabular row from being parsed.
type AdmissionOptions = { waitMs?: number; interactive?: boolean };

function admission(limit: number, maxWaiters = MAX_WAITERS) {
  const queue: Array<{ grant: () => void; interactive?: boolean }> = [];
  let active = 0;
  return async <T>(options: AdmissionOptions, work: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      if (options.waitMs === 0 || queue.length >= maxWaiters) throw new ExtractionBusyError();
      await new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grant = () => { clearTimeout(timer); resolve(); };
        const waiter = { grant, interactive: options.interactive };
        const background = options.interactive ? queue.findIndex((item) => !item.interactive) : -1;
        queue.splice(background < 0 ? queue.length : background, 0, waiter);
        if (options.waitMs !== undefined) timer = setTimeout(() => {
          queue.splice(queue.indexOf(waiter), 1);
          reject(new ExtractionBusyError());
        }, options.waitMs);
      });
    } else active++;
    try { return await work(); }
    finally {
      const next = queue.shift();
      if (next) next.grant();
      else active--;
    }
  };
}
const parserAdmission = admission(1);
const requestAdmission = admission(3);
// Only one background source is loaded at a time. Waiting jobs hold no buffers;
// durable jobs time out, while inline jobs must wait because no runner retries them.
const backgroundAdmission = admission(1, Infinity);

/** Reserve only the parser; source I/O belongs outside this slot. */
export function withExtractionSlot<T>(
  options: AdmissionOptions,
  work: (extract: ExtractInSlot) => Promise<T>,
): Promise<T> {
  return parserAdmission(options, () => work(extractInChild));
}

function queuedExtraction<K extends ExtractionOp>(op: K, bytes: ArrayBuffer, options?: { fileType?: string }): Promise<Result<K>> {
  return withExtractionSlot<Result<K>>({ interactive: true }, (extract) => extract(op, bytes, options));
}

/** Background I/O cannot block interactive parsing or fill its admission queue. */
export function withBackgroundExtraction<T>(
  options: { waitMs?: number },
  work: (extract: ExtractInSlot) => Promise<T>,
): Promise<T> {
  const started = Date.now();
  return backgroundAdmission(options, () => {
    const waitMs = options.waitMs === undefined ? undefined : Math.max(0, options.waitMs - (Date.now() - started));
    const extract: ExtractInSlot = (op, bytes, parseOptions) =>
      withExtractionSlot({ waitMs }, (parse) => parse(op, bytes, parseOptions));
    return work(extract);
  });
}

/** Three interactive sources may download/parse concurrently, matching tabular
 * row concurrency. Only the actual parser call takes the single parser slot. */
export function withExtractionRequest<T>(work: (extract: ExtractInSlot) => Promise<T>): Promise<T> {
  return requestAdmission({}, () => work(queuedExtraction));
}

export function runIsolatedExtraction<K extends ExtractionOp>(
  op: K,
  loadSource: () => Promise<ArrayBuffer | null>,
  options: { fileType?: string } = {},
): Promise<Result<K>> {
  return withExtractionRequest<Result<K>>(async (extract): Promise<Result<K>> => {
    const source = await loadSource();
    if (!source) throw new Error("document_text_source_unavailable");
    return extract(op, source, options);
  });
}
