type Folder = { id: string; parent_folder_id?: string | null };
export type FolderSummary = { count: number; selected: number; fullyLoaded: boolean };

/** One adjacency index and one postorder, with no retained descendant lists. */
export function indexFolderDirectory<F extends Folder, D extends { id: string }>(
    folders: readonly F[], documents: readonly D[], folderOf: (document: D) => string | null,
    selected: ReadonlySet<string> = new Set(), isLoaded: (id: string) => boolean = () => true,
) {
    const children = new Map<string | null, F[]>();
    const direct = new Map<string | null, D[]>();
    for (const folder of folders) {
        const parent = folder.parent_folder_id ?? null;
        let group = children.get(parent);
        if (!group) children.set(parent, group = []);
        group.push(folder);
    }
    for (const document of documents) {
        const parent = folderOf(document);
        let group = direct.get(parent);
        if (!group) direct.set(parent, group = []);
        group.push(document);
    }
    const summaries = new Map<string, FolderSummary>();
    const visited = new Set<string>();
    for (const folder of folders) {
        const pending: [string, boolean][] = [[folder.id, false]];
        while (pending.length) {
            const [id, exiting] = pending.pop()!;
            if (exiting) {
                const docs = direct.get(id) ?? [];
                const summary = { count: docs.length, selected: 0, fullyLoaded: isLoaded(id) };
                for (const doc of docs) if (selected.has(doc.id)) summary.selected++;
                for (const child of children.get(id) ?? []) {
                    const nested = summaries.get(child.id);
                    if (!nested) { summary.fullyLoaded = false; continue; }
                    summary.count += nested.count;
                    summary.selected += nested.selected;
                    summary.fullyLoaded &&= nested.fullyLoaded;
                }
                summaries.set(id, summary);
                continue;
            }
            if (visited.has(id)) continue;
            visited.add(id);
            pending.push([id, true]);
            for (const child of children.get(id) ?? []) if (!visited.has(child.id)) pending.push([child.id, false]);
        }
    }
    function collect(folderId: string): D[] {
        const result: D[] = [], seen = new Set<string>();
        const pending = [folderId];
        while (pending.length) {
            const id = pending.pop()!;
            if (seen.has(id)) continue;
            seen.add(id);
            result.push(...(direct.get(id) ?? []));
            const nested = children.get(id) ?? [];
            // Stack reversal retains the original depth-first selection order.
            for (let i = nested.length - 1; i >= 0; i--) pending.push(nested[i].id);
        }
        return result;
    }
    return { children, direct, summaries, collect };
}
