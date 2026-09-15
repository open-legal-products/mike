import { useEffect, useState } from "react";

// Module-level store so every picker shares one fetch and a refresh propagates
// to all of them. Resolves to an empty list when the source is unreachable or
// disabled; the app works without runtime-discovered models.
export function createDynamicModelStore<T>(fetchModels: () => Promise<T[]>): {
    refresh: () => Promise<T[]>;
    useModels: () => T[];
} {
    let cache: T[] | null = null;
    let inflight: Promise<T[]> | null = null;
    const listeners = new Set<() => void>();

    function load(force = false): Promise<T[]> {
        if (force) {
            cache = null;
            inflight = null;
        }
        if (cache) return Promise.resolve(cache);
        if (!inflight) {
            inflight = fetchModels()
                .then((m) => {
                    cache = m;
                    listeners.forEach((l) => l());
                    return m;
                })
                .catch(() => {
                    inflight = null; // don't poison cache; retry on next load
                    return [];
                });
        }
        return inflight;
    }

    // Clear the cache and refetch; mounted pickers update automatically.
    function refresh(): Promise<T[]> {
        return load(true);
    }

    function useModels(): T[] {
        const [models, setModels] = useState<T[]>(cache ?? []);

        useEffect(() => {
            const update = () => setModels(cache ?? []);
            listeners.add(update);
            void load().then(update);
            return () => {
                listeners.delete(update);
            };
        }, []);

        return models;
    }

    return { refresh, useModels };
}
