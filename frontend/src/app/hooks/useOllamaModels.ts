import { getOllamaModels, type OllamaModelOption } from "@/app/lib/mikeApi";
import { createDynamicModelStore } from "./dynamicModelStore";

// Empty list if Ollama is unreachable; the app works without it. The fetcher
// is wrapped so the API client is only touched on first load, not at import.
const store = createDynamicModelStore<OllamaModelOption>(() =>
    getOllamaModels(),
);

export function useOllamaModels(): OllamaModelOption[] {
    return store.useModels();
}
