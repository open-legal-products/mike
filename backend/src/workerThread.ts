// worker_threads bootstrap: the default home for background work in a
// single-process deployment. index.ts spawns one of these per worker role
// (uploads, jobs) so queue workers, upload processing, the DB-job runner, and
// maintenance sweeps run OFF the main event loop, and off each other's —
// an HTTP request can never be starved by a CPU-heavy job (zip building,
// export serialization, pdf parsing), and the seam to a fully separate
// worker process/machine (src/worker.ts) stays identical.

// Own Sentry client: worker_threads share no JS state with the parent, so
// the API process's init does not cover errors thrown in here.
import "./instrument";
import { parentPort, workerData } from "node:worker_threads";
import { startAllWorkers, stopAllWorkers, WORKER_ROLES, type WorkerRole } from "./workerRuntime";
import { flushSentry, reportError } from "./lib/observability/sentry";

// index.ts starts one thread per role; with no role, this thread runs them all.
const role = (workerData as { role?: WorkerRole } | null)?.role;
startAllWorkers(role ? [role] : WORKER_ROLES);
console.log(`[worker-thread] background workers started (${role ?? "all"})`);

parentPort?.on("message", (message: unknown) => {
    if (message === "shutdown") {
        void stopAllWorkers()
            .catch((err) => {
                reportError(err, { tags: { component: "worker-thread" } });
                console.error("[worker-thread] shutdown error", err);
            })
            .then(() => flushSentry())
            .finally(() => process.exit(0));
    }
});
