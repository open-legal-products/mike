import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable, Stream } from "node:stream";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { pipeToResponse } from "./pipeToResponse";

type Outcome = { error?: unknown; peakCloseListeners: number };

let server: http.Server | undefined;
const timers: NodeJS.Timeout[] = [];

afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  server?.closeAllConnections();
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  server = undefined;
});

/**
 * A stream from before async iteration, like JSZip's: 'data' events plus
 * pause, resume and destroy. It never ends, so only a disconnect stops it.
 */
function legacyStream(onDestroy: () => void): Readable {
  let paused = false;
  const stream = Object.assign(new Stream(), {
    pause: () => void (paused = true),
    resume: () => void (paused = false),
    destroy: () => {
      clearInterval(timer);
      onDestroy();
    },
  });
  const timer = setInterval(() => {
    if (!paused) stream.emit("data", Buffer.alloc(64 * 1024));
  }, 5);
  timers.push(timer);
  return stream as unknown as Readable;
}

/** Serve `makeSource()` through pipeToResponse; resolves with what it did. */
async function serve(makeSource: () => Readable, onError?: (res: http.ServerResponse) => void) {
  let settle!: (outcome: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (settle = resolve));
  server = http.createServer(async (_req, res) => {
    let peakCloseListeners = 0;
    const source = makeSource();
    source.on("data", () => {
      peakCloseListeners = Math.max(peakCloseListeners, res.listenerCount("close"));
    });
    try {
      await pipeToResponse(source, res);
      settle({ peakCloseListeners });
    } catch (error) {
      onError?.(res);
      settle({ error, peakCloseListeners });
    }
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, outcome };
}

describe("pipeToResponse", () => {
  it("sends every byte of a source larger than the socket buffer with one close listener", async () => {
    const chunk = Buffer.alloc(64 * 1024, "a");
    const { url, outcome } = await serve(() => Readable.from(Array.from({ length: 64 }, () => chunk)));

    const body = Buffer.from(await (await fetch(url)).arrayBuffer());

    expect(body.length).toBe(64 * chunk.length);
    const { error, peakCloseListeners } = await outcome;
    expect(error).toBeUndefined();
    // The server's own listeners plus ours; pipeline() added 7 here.
    expect(peakCloseListeners).toBeLessThanOrEqual(2);
  });

  it("streams a JSZip archive, whose node stream has no async iterator", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "hello");
    const { url, outcome } = await serve(
      () => zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }) as Readable,
    );

    const body = Buffer.from(await (await fetch(url)).arrayBuffer());

    expect((await outcome).error).toBeUndefined();
    const archive = await JSZip.loadAsync(body);
    expect(await archive.file("a.txt")!.async("string")).toBe("hello");
  });

  it("destroys the source and rejects when the client disconnects mid-stream", async () => {
    let source!: Readable;
    const { url, outcome } = await serve(() => {
      // Never ends: only the disconnect can stop it.
      source = new Readable({
        read() {
          setTimeout(() => this.push(Buffer.alloc(64 * 1024)), 5);
        },
      });
      return source;
    });

    const response = await fetch(url);
    await response.body!.cancel();

    const { error } = await outcome;
    expect((error as NodeJS.ErrnoException).code).toBe("ERR_STREAM_PREMATURE_CLOSE");
    expect(source.destroyed).toBe(true);
  });

  it("rejects and destroys the source when the client disconnects while the source is stalled", async () => {
    let source!: Readable;
    const { url, outcome } = await serve(() => {
      let sent = false;
      source = new Readable({
        read() {
          // One chunk, then silence: a storage read that never answers.
          if (sent) return;
          sent = true;
          this.push(Buffer.from("head"));
        },
      });
      return source;
    });

    const response = await fetch(url);
    const reader = response.body!.getReader();
    // Take the first chunk so the helper is waiting on the source, not on 'drain'.
    await reader.read();
    await reader.cancel();

    const { error } = await outcome;
    expect((error as NodeJS.ErrnoException).code).toBe("ERR_STREAM_PREMATURE_CLOSE");
    expect(source.destroyed).toBe(true);
  });

  it("destroys a legacy source, which the wrapper reads for it, when the client disconnects", async () => {
    let destroyed = false;
    const { url, outcome } = await serve(() => legacyStream(() => (destroyed = true)));

    const response = await fetch(url);
    await response.body!.cancel();

    const { error } = await outcome;
    expect((error as NodeJS.ErrnoException).code).toBe("ERR_STREAM_PREMATURE_CLOSE");
    expect(destroyed).toBe(true);
  });

  it("breaks the download when the source fails after bytes were sent", async () => {
    const { url, outcome } = await serve(() =>
      Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw new Error("storage read failed");
        })(),
      ),
    );

    const response = await fetch(url);
    await expect(response.arrayBuffer()).rejects.toThrow();
    expect(((await outcome).error as Error).message).toBe("storage read failed");
  });

  it("leaves the response usable when the source fails before any byte", async () => {
    const { url, outcome } = await serve(
      () =>
        Readable.from(
          (async function* (): AsyncGenerator<Buffer> {
            throw new Error("storage read failed");
          })(),
        ),
      (res) => res.writeHead(500).end("failed"),
    );

    const response = await fetch(url);

    expect(response.status).toBe(500);
    expect(((await outcome).error as Error).message).toBe("storage read failed");
  });
});
