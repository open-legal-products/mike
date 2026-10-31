/** A bounded operation-local promise cache coalesces concurrent source reads. */
export function createTextExtractionCache(maxCharacters = 8_000_000, maxEntries = 32) {
    const entries = new Map<string, { promise: Promise<string>; characters: number }>();
    let characters = 0;
    const remove = (key: string) => {
        const entry = entries.get(key);
        if (entry) characters -= entry.characters;
        entries.delete(key);
    };
    return (key: string, load: () => Promise<string>): Promise<string> => {
        const existing = entries.get(key);
        if (existing) return existing.promise;
        while (entries.size >= maxEntries && entries.size) remove(entries.keys().next().value!);
        const entry = { promise: Promise.resolve().then(load), characters: 0 };
        entries.set(key, entry);
        entry.promise = entry.promise.then(text => {
            if (entries.get(key) !== entry) return text;
            entry.characters = text.length;
            characters += text.length;
            while (characters > maxCharacters && entries.size) remove(entries.keys().next().value!);
            return text;
        }, error => { if (entries.get(key) === entry) remove(key); throw error; });
        return entry.promise;
    };
}
export type TextExtractionCache = ReturnType<typeof createTextExtractionCache>;
