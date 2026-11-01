interface FolderNode<D> {
  id: string;
  direct: readonly D[];
  /** Children whose summary existed when this folder finished (all of them, unless the tree is cyclic). */
  childIds: string[];
  missingChild: boolean;
  count: number;
}

interface DirectoryStructure<F, D> {
  children: Map<string | null, F[]>;
  directDocuments: Map<string | null, D[]>;
  /** Folders in postorder: every summarized child precedes its parent. */
  order: FolderNode<D>[];
  collect(folderId: string): D[];
}

/**
 * Structure depends only on the folder and document arrays, which the picker
 * replaces (never mutates) when a level loads. Keyed weakly by both arrays,
 * so a checkbox toggle reuses it and a dropped project's index is collected.
 */
const structures = new WeakMap<readonly object[], WeakMap<readonly object[], DirectoryStructure<never, never>>>();

function buildStructure<
  F extends { id: string; parent_folder_id?: string | null },
  D extends { id: string; folder_id?: string | null; library_folder_id?: string | null },
>(folders: readonly F[], documents: readonly D[]): DirectoryStructure<F, D> {
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
  const counts = new Map<string, number>();
  const order: FolderNode<D>[] = [];
  const visiting = new Set<string>();
  // Iterative postorder also handles deep imported trees without call-stack growth.
  for (const folder of folders) {
    const stack: { id: string; finish: boolean }[] = [{ id: folder.id, finish: false }];
    while (stack.length) {
      const entry = stack.pop()!;
      if (counts.has(entry.id)) continue;
      if (!entry.finish) {
        if (visiting.has(entry.id)) continue;
        visiting.add(entry.id);
        stack.push({ id: entry.id, finish: true });
        for (const child of children.get(entry.id) ?? []) {
          if (!visiting.has(child.id)) stack.push({ id: child.id, finish: false });
        }
      } else {
        const direct = directDocuments.get(entry.id) ?? [];
        const node: FolderNode<D> = { id: entry.id, direct, childIds: [], missingChild: false, count: direct.length };
        for (const child of children.get(entry.id) ?? []) {
          const childCount = counts.get(child.id);
          // Broken/cyclic trees cannot be selected as complete.
          if (childCount === undefined) { node.missingChild = true; continue; }
          node.count += childCount;
          node.childIds.push(child.id);
        }
        counts.set(entry.id, node.count);
        order.push(node);
        visiting.delete(entry.id);
      }
    }
  }
  return {
    children,
    directDocuments,
    order,
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

/**
 * One adjacency index and one postorder pass, rather than a subtree walk per
 * row. The structure is built once per folder/document arrays; selection and
 * loaded state, which change on every checkbox toggle or level load, are a
 * flat pass over the precomputed postorder.
 */
export function buildDirectoryIndex<
  F extends { id: string; parent_folder_id?: string | null },
  D extends { id: string; folder_id?: string | null; library_folder_id?: string | null },
>(folders: readonly F[], documents: readonly D[], selected: ReadonlySet<string>, levelLoaded: (id: string) => boolean) {
  let byDocuments = structures.get(folders);
  if (!byDocuments) structures.set(folders, byDocuments = new WeakMap());
  let structure = byDocuments.get(documents) as DirectoryStructure<F, D> | undefined;
  if (!structure) {
    structure = buildStructure(folders, documents);
    byDocuments.set(documents, structure as DirectoryStructure<never, never>);
  }
  const summaries = new Map<string, { count: number; selected: number; loaded: boolean }>();
  for (const node of structure.order) {
    let selectedCount = 0;
    for (const document of node.direct) if (selected.has(document.id)) selectedCount++;
    let loaded = levelLoaded(node.id) && !node.missingChild;
    for (const childId of node.childIds) {
      const summary = summaries.get(childId)!;
      selectedCount += summary.selected;
      loaded = loaded && summary.loaded;
    }
    summaries.set(node.id, { count: node.count, selected: selectedCount, loaded });
  }
  return {
    children: structure.children,
    directDocuments: structure.directDocuments,
    summaries,
    collect: structure.collect,
  };
}
