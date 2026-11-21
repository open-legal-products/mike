// Destructive resource outcomes use child stubs, never real resource stress.
import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { ExtractionLimitError, stopExtractionProcess, withExtractionSlot } from "../isolated";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));

afterEach(async () => {
  await stopExtractionProcess();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each(["deadline", "memory", "crash", "cancellation"])("retires the DOCX parser and removes scratch after %s (stub child)", async (outcome) => {
  vi.stubEnv("EXTRACTION_ISOLATION", "on");
  vi.stubEnv("EXTRACTION_TIMEOUT_MS", "20");
  // Never address a real process group in this stub-only test.
  vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("stub process group"); });
  let sent!: () => void;
  const requestSent = new Promise<void>((resolve) => { sent = resolve; });
  const child = Object.assign(new EventEmitter(), {
    pid: 2147483647, stderr: Object.assign(new PassThrough(), { ref() {}, unref() {} }), channel: { ref() {}, unref() {} },
    ref() {}, unref() {},
    kill: vi.fn(() => { setImmediate(() => child.emit("close", null, "SIGKILL")); return true; }),
    send: vi.fn((request: { op: string }, callback: (error: Error | null) => void) => {
      expect(request.op).toBe("validateDocxPackage");
      callback(null);
      sent();
      if (outcome === "memory") setImmediate(() => child.emit("message", { ok: false, limited: true, message: "parser resource budget exceeded" }));
      if (outcome === "crash") setImmediate(() => child.emit("close", 1, null));
      return true;
    }),
  });
  vi.mocked(spawn).mockImplementationOnce((() => {
    setImmediate(() => child.emit("spawn"));
    return child;
  }) as unknown as typeof spawn);
  const pending = withExtractionSlot({ waitMs: 0 }, (extract) => extract("validateDocxPackage", new ArrayBuffer(1)));
  const result = pending.catch((error: unknown) => error);
  await Promise.race([requestSent, result.then((error) => { throw error; })]);
  if (outcome === "cancellation") await stopExtractionProcess();
  const error = await result;
  expect(error).toBeInstanceOf(Error);
  if (outcome === "memory" || outcome === "deadline") expect(error).toBeInstanceOf(ExtractionLimitError);
  else {
    expect(error).not.toBeInstanceOf(ExtractionLimitError);
    expect((error as Error).message).toBe("extraction process exited without a result");
  }
  const scratch = vi.mocked(spawn).mock.calls.at(-1)![2]!.env!.TMPDIR!;
  expect(existsSync(scratch)).toBe(false);
  expect(child.kill).toHaveBeenCalled();
  expect(child.listenerCount("message")).toBe(0);
  expect(child.listenerCount("error")).toBe(1); // Existing idle-error retirement listener.
  await expect(withExtractionSlot({ waitMs: 0 }, async () => "released")).resolves.toBe("released");
});
