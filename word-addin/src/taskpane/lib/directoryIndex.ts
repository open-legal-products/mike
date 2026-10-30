/** One adjacency index and one postorder pass, rather than a subtree walk per row. */
export function buildDirectoryIndex<
  F extends { id: string; parent_folder_id?: string | null },
  D extends { id: string; folder_id?: string | null; library_folder_id?: string | null },
>(folders: readonly F[], documents: readonly D[], selected: ReadonlySet<string>, levelLoaded: (id: string) => boolean) {
  const children = new Map<string | null, F[]>();
  const directDocuments = new Map<string | null, D[]>();
  for (const folder of folders) {
    const parent = folder.parent_folder_id ?? null;
    const bucket = children.get(parent) ?? [];
    bucket.push(folder);
    children.set(parent, bucket);
  }
  for (const document of documents) {
    const parent = document.folder_id ?? document.library_folder_id ?? null;
    const bucket = directDocuments.get(parent) ?? [];
    bucket.push(document);
    directDocuments.set(parent, bucket);
  }
  const summaries = new Map<string, { count: number; selected: number; loaded: boolean }>();
  const visiting = new Set<string>();
  // Iterative postorder also handles deep imported trees without call-stack growth.
  for (const folder of folders) {
    const stack: { id: string; finish: boolean }[] = [{ id: folder.id, finish: false }];
    while (stack.length) {
      const entry = stack.pop()!;
      if (summaries.has(entry.id)) continue;
      if (!entry.finish) {
        if (visiting.has(entry.id)) continue;
        visiting.add(entry.id);
        stack.push({ id: entry.id, finish: true });
        for (const child of children.get(entry.id) ?? []) {
          if (!visiting.has(child.id)) stack.push({ id: child.id, finish: false });
        }
      } else {
        const direct = directDocuments.get(entry.id) ?? [];
        let count = direct.length;
        let selectedCount = 0;
        for (const document of direct) if (selected.has(document.id)) selectedCount++;
        let loaded = levelLoaded(entry.id);
        for (const child of children.get(entry.id) ?? []) {
          const summary = summaries.get(child.id);
          if (!summary) { loaded = false; continue; } // Broken/cyclic trees cannot be selected as complete.
          count += summary.count;
          selectedCount += summary.selected;
          loaded = loaded && summary.loaded;
        }
        summaries.set(entry.id, { count, selected: selectedCount, loaded });
        visiting.delete(entry.id);
      }
    }
  }
  return {
    children,
    directDocuments,
    summaries,
    collect(folderId: string): D[] {
      const result: D[] = [];
      const stack = [folderId];
      const seen = new Set<string>();
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        result.push(...(directDocuments.get(id) ?? []));
        const nested = children.get(id) ?? [];
        for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]!.id);
      }
      return result;
    },
  };
}
