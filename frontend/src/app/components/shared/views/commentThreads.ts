import type { ReviewCommentPlacement } from "@docx-editor.dev/core/contracts/editor";

/** Resolve each ancestry edge once, retaining the original order of replies. */
export function groupCommentThreads(items: readonly ReviewCommentPlacement[]) {
    const byId = new Map(items.map(item => [item.id, item]));
    const rootByKey = new Map<string, string>();
    for (const start of items) {
        if (rootByKey.has(start.key)) continue;
        const path: ReviewCommentPlacement[] = [];
        const position = new Map<string, number>();
        let current = start;
        let root: string;
        for (;;) {
            const known = rootByKey.get(current.key);
            if (known !== undefined) { root = known; break; }
            const cycleStart = position.get(current.key);
            if (cycleStart !== undefined) {
                // The old guarded ancestor walk treats each cycle member as
                // its own root. Preserve that behavior for malformed imports.
                for (let i = cycleStart; i < path.length; i++) rootByKey.set(path[i].key, path[i].key);
                root = current.key;
                path.length = cycleStart;
                break;
            }
            position.set(current.key, path.length);
            path.push(current);
            const parent = current.parentId ? byId.get(current.parentId) : undefined;
            if (!parent) { root = current.key; break; }
            current = parent;
        }
        for (const item of path) rootByKey.set(item.key, root);
    }
    const threads: ReviewCommentPlacement[] = [];
    const replies = new Map<string, ReviewCommentPlacement[]>();
    for (const item of items) {
        const root = rootByKey.get(item.key)!;
        if (root === item.key) threads.push(item);
        else {
            let group = replies.get(root);
            if (!group) replies.set(root, group = []);
            group.push(item);
        }
    }
    threads.sort((a, b) => (a.anchorY ?? Infinity) - (b.anchorY ?? Infinity));
    const active = items.find(item => item.isActive);
    return { threads, replies, activeThread: active ? rootByKey.get(active.key) : undefined };
}
