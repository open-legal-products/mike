import type { DocIndex, DocStore } from "../types";

type DocEntry = DocStore extends Map<string, infer Entry> ? Entry : never;

/** Writes reach the answer's store too, so it can cite and reuse what the subagent made. */
class ScopedDocStore extends Map<string, DocEntry> {
  constructor(
    private readonly shared: DocStore,
    labels: string[],
  ) {
    super();
    for (const label of labels) {
      const entry = shared.get(label);
      if (entry) super.set(label, entry);
    }
  }

  set(label: string, entry: DocEntry): this {
    this.shared.set(label, entry);
    return super.set(label, entry);
  }
}

function scopedDocIndex(shared: DocIndex, labels: string[]): DocIndex {
  const own: DocIndex = {};
  for (const label of labels) {
    if (shared[label]) own[label] = shared[label];
  }
  return new Proxy(own, {
    // A new label is chosen against the whole answer's, so it never takes one
    // this subagent cannot see.
    has: (target, label) => label in target || label in shared,
    set: (target, label, entry) => {
      if (typeof label !== "string") return false;
      target[label] = entry;
      shared[label] = entry;
      return true;
    },
  });
}

/**
 * The documents a scoped subagent can see and use: only `labels`, plus any it
 * creates. The answer's own stores keep every document.
 */
export function scopedDocuments(
  docStore: DocStore,
  docIndex: DocIndex,
  labels: string[],
): { docStore: DocStore; docIndex: DocIndex } {
  return {
    docStore: new ScopedDocStore(docStore, labels),
    docIndex: scopedDocIndex(docIndex, labels),
  };
}
