import { WORKER_REGISTRY } from "./registry";
import { closeRedisConnection } from "../lib/queue/connection";
import { log, tpl } from "../lib/log";

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
        log.info(tpl`[workers] ${w.name} worker started`);
    }
}

export async function stopWorkers(): Promise<void> {
    for (const w of WORKER_REGISTRY) await w.stop();
    for (const w of WORKER_REGISTRY) await w.closeQueue();
    await closeRedisConnection();
}
