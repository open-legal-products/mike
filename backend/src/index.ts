// Sentry must hook http/express before anything else loads (see file).
import "./instrument";
import type { Server } from "node:http";
import { Worker as ThreadWorker } from "node:worker_threads";
import path from "node:path";
import { app } from "./app";
import { enforceDocumentLifecycleMigration } from "./lib/dbq/lifecycleGuard";
import { manifestPublicKey } from "./lib/manifestSigning";
import { validateRuntimeConfiguration } from "./lib/runtimeConfig";
import { startAllWorkers, stopAllWorkers } from "./workerRuntime";
import { flushSentry, reportError } from "./lib/observability/sentry";

const PORT = process.env.PORT ?? 3001;

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
//
// Runs inside main() and is awaited: the fatal report has to be flushed to
// Sentry before exit, and while that flush is in flight nothing below may
// bind the port or start a worker — a process that has already decided to
// exit must not serve a request or claim a job in its last two seconds.
async function validateBootConfiguration(): Promise<void> {
  try {
    validateRuntimeConfiguration();
    const signingKey = manifestPublicKey();
    if (signingKey) {
      console.log(`Export manifests signed with key ${signingKey.key_id}`);
    }
  } catch (err) {
    reportError(err, { tags: { component: "boot" }, level: "fatal" });
    console.error(err instanceof Error ? err.message : String(err));
    await flushSentry();
    process.exit(1);
  }
}

/**
 * Where background work runs, relative to this API process:
 *   "thread" (default) — a worker_thread in this process: queue workers and
 *            maintenance run off the main event loop, so a CPU-heavy job can
 *            never starve HTTP requests, with zero deployment changes.
 *   "inline" — on the main thread (the historical behavior; escape hatch,
 *            e.g. if a platform disallows worker_threads).
 *   "none"  — not here at all: a standalone worker process (src/worker.ts)
 *            runs them — a separate container or machine on the same
 *            Postgres/Redis.
 */
const WORKERS_MODE = (() => {
  const raw = process.env.WORKERS_MODE;
  return raw === "inline" || raw === "none" ? raw : "thread";
})();

let workerThread: ThreadWorker | null = null;
let shuttingDown = false;

function spawnWorkerThread(): void {
  // In dev (tsx) this file is .ts and the thread entry must be too, loaded
  // through tsx's CJS require hook; in prod both are compiled .js in dist.
  const isTs = __filename.endsWith(".ts");
  const entry = path.join(
    __dirname,
    isTs ? "workerThread.ts" : "workerThread.js",
  );
  workerThread = new ThreadWorker(entry, {
    execArgv: isTs ? ["--require", "tsx/cjs"] : [],
  });
  workerThread.on("error", (err) => {
    // An uncaught throw inside the thread. The thread's own Sentry client
    // reports it with the real stack and job context; what arrives here is
    // a structured clone. Sentry groups, it does not deduplicate, so this
    // supervisor view is fingerprinted as its own issue ("a worker thread
    // crashed", with a count) rather than doubling every thread issue.
    reportError(err, {
      tags: { component: "worker-thread-supervisor" },
      fingerprint: ["worker-thread-supervisor-error"],
    });
    console.error("[worker-thread] error", err);
  });
  workerThread.on("exit", (code) => {
    workerThread = null;
    if (shuttingDown || code === 0) return;
    // A crashed worker thread must not silently kill all background
    // processing — respawn after a short pause. Durable state (db_jobs,
    // Redis) means nothing is lost across the gap.
    reportError(
      new Error(`Background worker thread exited with code ${code}`),
      {
        tags: { component: "worker-thread-supervisor" },
        extra: { exit_code: code },
        fingerprint: ["worker-thread-exit"],
      },
    );
    console.error(
      `[worker-thread] exited with code ${code}; respawning in 5s`,
    );
    setTimeout(spawnWorkerThread, 5_000).unref();
  });
}

let server: Server | null = null;

async function main(): Promise<void> {
  await validateBootConfiguration();
  // Deploying this code against a database that has not run the
  // document-lifecycle migrations leaks storage silently and fails every
  // upload — see lifecycleGuard. The probe is AWAITED before the port is
  // bound and before any worker starts: a destructive request that arrives
  // while the check is still in flight would otherwise be served by code the
  // database cannot back. The guard exits the process when the migration is
  // provably absent and only warns when the answer is unavailable, so the
  // cost of gating is one round trip of boot latency, never a crash loop.
  await enforceDocumentLifecycleMigration();

  server = app.listen(PORT, () => {
    console.log(
      `Mike backend running on port ${PORT} (workers: ${WORKERS_MODE})`,
    );
    if (WORKERS_MODE === "thread") {
      spawnWorkerThread();
    } else if (WORKERS_MODE === "inline") {
      startAllWorkers();
    }
    // WORKERS_MODE === "none": a standalone worker process owns background
    // work (node dist/worker.js).
  });
}

void main();

// Graceful shutdown: on SIGTERM/SIGINT (orchestrator rollout, Ctrl-C), stop
// accepting new connections, let in-flight requests/streams drain, stop the
// background workers wherever they run, then exit 0. A hard timeout guards
// against a connection or job that never drains.
async function stopBackgroundWork(): Promise<void> {
  if (WORKERS_MODE === "inline") {
    await stopAllWorkers();
    return;
  }
  const thread = workerThread;
  if (!thread) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => resolve(), 10_000);
    timeout.unref();
    thread.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    thread.postMessage("shutdown");
  });
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shutting down gracefully (${signal})`);
  const forceExit = setTimeout(() => {
    console.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  try {
    const listening = server;
    if (listening)
      await new Promise<void>((resolve, reject) =>
        listening.close((err) => (err ? reject(err) : resolve())),
      );
    await stopBackgroundWork();
    await flushSentry();
    console.log("Shutdown complete");
    process.exit(0);
  } catch (err) {
    reportError(err, { tags: { component: "shutdown" } });
    console.error("Error during graceful shutdown", err);
    await flushSentry();
    process.exit(1);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
