import { useEffect, useState } from "react";
import { getOllamaModels, type OllamaModelOption } from "@/app/lib/mikeApi";

// Module-level store so every picker shares one fetch. Empty list if Ollama
// is unreachable — the app works without it.
let cache: OllamaModelOption[] | null = null;
let inflight: Promise<OllamaModelOption[]> | null = null;
const listeners = new Set<() => void>();

function load(): Promise<OllamaModelOption[]> {
    if (cache) return Promise.resolve(cache);
    if (!inflight) {
        inflight = getOllamaModels()
            .then((m) => {
                cache = m;
                listeners.forEach((l) => l());
                return m;
            })
            .catch(() => {
                inflight = null; // don't poison cache — retry on next load
                return [];
            });
    }
    return inflight;
}

export function useOllamaModels(): OllamaModelOption[] {
    const [models, setModels] = useState<OllamaModelOption[]>(cache ?? []);

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
