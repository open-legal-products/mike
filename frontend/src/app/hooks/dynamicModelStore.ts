import { useEffect, useState } from "react";

// Module-level store so every picker shares one fetch and one cache. Resolves
// to an empty list when the source is unreachable or disabled; the app works
// without runtime-discovered models. The catalog is fixed for the life of the
// page, so there is no invalidation: a picker that must see new models reloads.
export function createDynamicModelStore<T>(fetchModels: () => Promise<T[]>): {
    useModels: () => T[];
} {
    let cache: T[] | null = null;
    let inflight: Promise<T[]> | null = null;
    const listeners = new Set<() => void>();

    function load(): Promise<T[]> {
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

    return { useModels };
}
