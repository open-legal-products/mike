// Boot-failure and graceful-shutdown mechanics for the API entrypoint
// (src/index.ts). They live here, with their side effects injected, because
// index.ts starts a server and registers signal handlers at import time and
// so cannot be exercised by a unit test.

import type { Server } from "node:http";
import { flushSentry, reportError } from "./observability/sentry";

export interface LifecycleEffects {
  report: typeof reportError;
  /** Operator-facing log line; the console bridge watches console.error. */
  logError: (...args: unknown[]) => void;
  logInfo: (...args: unknown[]) => void;
  flush: () => Promise<void>;
  exit: (code: number) => void;
}

export const processEffects: LifecycleEffects = {
  report: reportError,
  logError: (...args) => console.error(...args),
  logInfo: (...args) => console.log(...args),
  flush: flushSentry,
  exit: (code) => process.exit(code),
};

/**
 * Report a boot failure once, tell the operator why, and exit 1.
 *
 * The Error OBJECT goes to console.error, not just its message. Sentry's
 * console bridge files every console.error as its own event and recognises
 * an error that reportError() already sent only by object identity; a
 * logged string is new text to it, so one failed boot used to arrive as two
 * issues ("Failure in boot" plus a context-free "Failure in application").
 */
export async function failBoot(
  err: unknown,
  stage: string,
  effects: LifecycleEffects = processEffects,
): Promise<void> {
  effects.report(err, { tags: { component: "boot", stage }, level: "fatal" });
  effects.logError("Mike backend failed to start:", err);
  await effects.flush();
  effects.exit(1);
}

interface Listenable {
  listen(port: number | string, callback: (error?: Error) => void): Server;
  listen(
    port: number | string,
    host: string,
    callback: (error?: Error) => void,
  ): Server;
}

/**
 * Bind the HTTP port, failing the boot when binding fails.
 *
 * Express 5 hands a listen error (EADDRINUSE, EACCES) to the listen callback
 * instead of throwing. Treating that callback as "listening" left a process
 * that bound nothing yet logged "running", started its workers and stayed up
 * until someone stopped it — at which point closing the never-opened server
 * failed with ERR_SERVER_NOT_RUNNING and was filed as a shutdown error.
 */
export function listenOrFail(
  app: Listenable,
  port: number | string,
  onListening: () => void,
  effects: LifecycleEffects = processEffects,
  host?: string,
): Server {
  const onListen = (error?: Error) => {
    if (error) {
      void failBoot(error, "listen", effects);
      return;
    }
    onListening();
  };
  return host ? app.listen(port, host, onListen) : app.listen(port, onListen);
}

/**
 * Stop accepting connections and wait for in-flight requests to drain.
 * A server that is not running (never bound, or already closed) is already
 * in the state shutdown wants, so that is success rather than an error.
 */
export function closeHttpServer(
  server: Pick<Server, "close"> | null,
): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (!err || code === "ERR_SERVER_NOT_RUNNING") {
        resolve();
      } else {
        reject(err);
      }
    });
  });
}

export interface ShutdownOptions {
  closeServer: () => Promise<void>;
  stopBackgroundWork: () => Promise<void>;
  /** Called once, before anything is stopped (e.g. to silence respawns). */
  onStart?: () => void;
  timeoutMs?: number;
  effects?: LifecycleEffects;
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests
 * drain, stop background work, flush telemetry, exit 0. Idempotent: a second
 * signal (Ctrl-C twice, SIGINT then SIGTERM from a supervisor) while the
 * first shutdown is running is ignored rather than racing it. A genuine
 * failure is still reported, tagged with the step that failed.
 */
export function createShutdown({
  closeServer,
  stopBackgroundWork,
  onStart,
  timeoutMs = 15_000,
  effects = processEffects,
}: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    onStart?.();
    effects.logInfo(`Shutting down gracefully (${signal})`);
    const forceExit = setTimeout(() => {
      effects.logError("Graceful shutdown timed out — forcing exit");
      effects.exit(1);
    }, timeoutMs);
    forceExit.unref();
    let stage = "shutdown-http";
    try {
      await closeServer();
      stage = "shutdown-workers";
      await stopBackgroundWork();
      stage = "shutdown-flush";
      await effects.flush();
      clearTimeout(forceExit);
      effects.logInfo("Shutdown complete");
      effects.exit(0);
    } catch (err) {
      clearTimeout(forceExit);
      effects.report(err, { tags: { component: "shutdown", stage } });
      effects.logError("Error during graceful shutdown", err);
      await effects.flush();
      effects.exit(1);
    }
  };
}
