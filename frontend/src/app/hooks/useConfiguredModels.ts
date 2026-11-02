import { useEffect, useState } from "react";
import {
    getConfiguredModels,
    type ConfiguredModelOption,
} from "@/app/lib/mikeApi";

// Deployment configuration is shared by every picker. Keep one request and
// notify all mounted consumers when it resolves, just like Ollama discovery.
let cache: ConfiguredModelOption[] | null = null;
/** When `cache` was filled; a mount older than the freshness window revalidates. */
let loadedAt = 0;
let inflight: Promise<ConfiguredModelOption[]> | null = null;
let generation = 0;
/**
 * The provider invalidates the catalog for everything this tab does
 * (sign-in, user change, API-key save). A key saved in ANOTHER tab reaches
 * this one only through this bound: a picker that mounts after it refetches
 * once, and pickers mounting inside it share the loaded catalog, so one page
 * load still costs one request.
 */
export const CONFIGURED_MODELS_MAX_AGE_MS = 60_000;
const listeners = new Set<() => void>();

function load(force = false): Promise<ConfiguredModelOption[]> {
    if (force) {
        generation += 1;
        cache = null;
        inflight = null;
    }
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        const requestGeneration = generation;
        const request: Promise<ConfiguredModelOption[]> = getConfiguredModels()
            .then((models) => {
                if (requestGeneration !== generation) return models;
                cache = models;
                loadedAt = Date.now();
                listeners.forEach((listener) => listener());
                return models;
            })
            .catch(() => {
                if (requestGeneration === generation) {
                    listeners.forEach((listener) => listener());
                }
                return [];
            })
            .finally(() => {
                if (inflight === request) inflight = null;
            });
        inflight = request;
    }
    return inflight;
}

export function refreshConfiguredModels(): Promise<ConfiguredModelOption[]> {
    return load(true);
}

export function clearConfiguredModels(): void {
    generation += 1;
    cache = null;
    inflight = null;
    listeners.forEach((listener) => listener());
}

export function useConfiguredModels(): ConfiguredModelOption[] {
    const [models, setModels] = useState<ConfiguredModelOption[]>(cache ?? []);

    useEffect(() => {
        const update = () => setModels(cache ?? []);
        listeners.add(update);
        // Use the shared catalog while it is fresh. Invalidation is the
        // provider's job: UserProfileProvider clears/refreshes it on every
        // sign-in and user change and after an API-key save, so a mount never
        // sees a stale user's catalog. Forcing a refetch on every mount
        // instead meant every picker that mounted after the provider's
        // request had resolved (the page chunk always mounts later than the
        // shell) sent a second GET /models/configured per page load
        // (MIKE-FRONTEND-C). The age bound covers what the provider cannot
        // see: a key change made in another tab.
        const stale =
            cache !== null && Date.now() - loadedAt > CONFIGURED_MODELS_MAX_AGE_MS;
        void load(stale).then(update);
        return () => {
            listeners.delete(update);
        };
    }, []);

    return models;
}
