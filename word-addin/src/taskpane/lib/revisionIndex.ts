/** Index one freshly loaded Word revision inventory; never reuse across mutations. */
export function createRevisionIndex<T>(items: readonly T[], typeOf: (item: T) => string, textOf: (item: T) => string) {
  const byType = new Map<string, T[]>();
  const byText = new Map<string, Map<string, T[]>>();
  const deletedByText = new Map<string, T[]>();
  const textParts = new Map<string, string[]>();
  const normalize = (text: string) => text.replace(/[\r\n\v]+/g, "\n");
  function append<K>(map: Map<K, T[]>, key: K, item: T) {
    const bucket = map.get(key) ?? []; bucket.push(item); map.set(key, bucket);
  }
  for (const item of items) {
    const type = typeOf(item);
    const raw = textOf(item);
    const text = normalize(raw);
    append(byType, type, item);
    const texts = byText.get(type) ?? new Map<string, T[]>();
    append(texts, text, item); byText.set(type, texts);
    const parts = textParts.get(type) ?? []; parts.push(raw); textParts.set(type, parts);
    if (type === "deleted" || type === "Delete") {
      append(deletedByText, text, item);
      const trimmed = text.replace(/\n+$/, "");
      if (trimmed !== text) append(deletedByText, trimmed, item);
    }
  }
  const joined = new Map([...textParts].map(([type, parts]) => [type, normalize(parts.join(""))]));
  return {
    all: (type: string): readonly T[] => byType.get(type) ?? [],
    matching: (type: string, text: string): readonly T[] => byText.get(type)?.get(text) ?? [],
    deleted: (original: string): readonly T[] => deletedByText.get(original) ?? [],
    joined: (type: string): string => joined.get(type) ?? "",
    size: items.length,
  };
}
export type RevisionIndex<T> = ReturnType<typeof createRevisionIndex<T>>;
