import { stopAppJobIntake } from "./appJobsWorker";
import { WORKER_REGISTRY } from "./registry";
import { closeRedisConnection } from "../lib/queue/connection";

/** True when at least one background worker is enabled by the current config. */
export function anyWorkerEnabled(): boolean {
    return WORKER_REGISTRY.some((w) => w.enabled());
}

/**
 * Start the in-process BullMQ workers whose feature flag is on. Called from the
 * server entrypoint only when `anyWorkerEnabled()`, so the default (synchronous)
 * deployment needs no Redis. Running workers in the API process keeps the
 * dev/single-node story simple; split them into a dedicated process by calling
 * this from a separate entrypoint when you need to scale them apart.
 */
export function startWorkers(): void {
    for (const w of WORKER_REGISTRY) {
        if (!w.enabled()) continue;
        w.create();
        console.log(`[workers] ${w.name} worker started`);
    }
}

/** Close app-job claim intake synchronously before any worker drain is awaited. */
export function stopWorkerIntake(): void {
    stopAppJobIntake();
}

/** Await every worker and resource closure before propagating aggregate shutdown failures. */
export async function stopWorkers(): Promise<void> {
    stopWorkerIntake();
    const stops = await Promise.allSettled(WORKER_REGISTRY.map((w) => w.stop()));
    const queues = await Promise.allSettled(WORKER_REGISTRY.map((w) => w.closeQueue()));
    const connection = await Promise.allSettled([closeRedisConnection()]);
    const failures = [...stops, ...queues, ...connection]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, "Worker shutdown failed");
}
