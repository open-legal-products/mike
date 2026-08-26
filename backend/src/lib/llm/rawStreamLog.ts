import { randomUUID } from "crypto";
import { mkdir, open } from "fs/promises";
import type { FileHandle } from "fs/promises";
import path from "path";

type RawStreamEntry = {
  timestamp: string;
  iteration: number;
  label: string;
  payload: unknown;
};

// These logs contain the verbatim prompt and completion — privileged client
// content — so they are a development-only aid. Both entry points hard-refuse
// to run under NODE_ENV=production regardless of how the env is configured.
function rawStreamLoggingAllowed(): boolean {
  return process.env.NODE_ENV !== "production";
}

function rawStreamLogDir(): string | null {
  if (!rawStreamLoggingAllowed()) return null;
  return process.env.RAW_LLM_STREAM_LOG_DIR?.trim() || null;
}

function safeFilePart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function stringifyJson(value: unknown) {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, innerValue: unknown) => {
    if (typeof innerValue === "bigint") return innerValue.toString();
    if (innerValue instanceof Error) {
      return {
        name: innerValue.name,
        message: innerValue.message,
        stack: innerValue.stack,
      };
    }
    if (innerValue && typeof innerValue === "object") {
      if (seen.has(innerValue)) return "[Circular]";
      seen.add(innerValue);
    }
    return innerValue;
  });
}

export function logRawLlmStream(args: {
  provider: string;
  model: string;
  iteration: number;
  label: string;
  payload: unknown;
}) {
  if (!rawStreamLoggingAllowed()) return;
  if (process.env.LOG_RAW_LLM_STREAM !== "true") return;

  console.log(
    `[raw-llm-stream:${args.provider}:${args.model}:iter-${args.iteration}] ${args.label}`,
  );
  console.dir(args.payload, { depth: null, maxArrayLength: null });
}

export function createRawLlmStreamRecorder(args: {
  provider: string;
  model: string;
}) {
  if (!rawStreamLoggingAllowed()) return null;
  const dir = rawStreamLogDir();
  if (!dir) return null;
  const logDir = dir;

  const startedAt = new Date();
  const id = randomUUID();
  const filename = [
    safeFilePart(args.provider),
    safeFilePart(args.model),
    startedAt.toISOString().replace(/[:.]/g, "-"),
    id,
  ].join("-");
  const filePath = path.join(logDir, `${filename}.raw-llm-stream.json`);
  let fileHandle: FileHandle | null = null;
  let writeChain: Promise<void> = Promise.resolve();
  let writeError: unknown = null;
  let wroteEntry = false;
  let finalized = false;

  async function ensureOpen() {
    if (fileHandle) return fileHandle;
    await mkdir(logDir, { recursive: true });
    fileHandle = await open(filePath, "w");
    const header = {
      id,
      provider: args.provider,
      model: args.model,
      startedAt: startedAt.toISOString(),
    };
    await fileHandle.write(`${stringifyJson(header)?.slice(0, -1)},"entries":[`);
    return fileHandle;
  }

  function queueWrite(action: () => Promise<void>) {
    writeChain = writeChain
      .then(action)
      .catch((error) => {
        writeError = error;
        console.error("[raw-llm-stream] failed to write log file", {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  return {
    record(entry: Omit<RawStreamEntry, "timestamp">) {
      if (finalized) return;
      const rawEntry = {
        timestamp: new Date().toISOString(),
        ...entry,
      };
      queueWrite(async () => {
        const handle = await ensureOpen();
        const serialized =
          stringifyJson(rawEntry) ??
          stringifyJson({
            timestamp: rawEntry.timestamp,
            iteration: rawEntry.iteration,
            label: rawEntry.label,
            payload: "[Unserializable payload]",
          });
        await handle.write(`${wroteEntry ? "," : ""}${serialized}`);
        wroteEntry = true;
      });
    },
    async flush(status: "completed" | "error", error?: unknown) {
      if (finalized) return;
      finalized = true;
      const errorPayload =
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error
          ? { message: String(error) }
          : undefined;

      const footer = {
        finishedAt: new Date().toISOString(),
        status,
        error: errorPayload,
      };

      try {
        await writeChain;
        const handle = await ensureOpen();
        await handle.write(`],${stringifyJson(footer)?.slice(1)}\n`);
      } catch (writeError) {
        console.error("[raw-llm-stream] failed to write log file", {
          filePath,
          error:
            writeError instanceof Error
              ? writeError.message
              : String(writeError),
        });
      } finally {
        if (fileHandle) {
          await fileHandle.close().catch(() => {});
          fileHandle = null;
        }
        if (writeError) {
          console.error("[raw-llm-stream] log file may be incomplete", {
            filePath,
          });
        }
      }
    },
  };
}
