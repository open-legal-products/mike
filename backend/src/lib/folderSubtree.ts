import { selectAllByKey, selectInBatches } from "./batchedQuery";
import { walkFolderGraph } from "./folderTree";

/**
 * The ids of `rootIds` and every folder beneath them, read one tree level
 * per round trip (batched, paged) instead of loading every folder in the
 * scope. `childrenOf(parentIds)` returns the caller's SCOPED builder for
 * child folders (`select("id")` … `.in("parent_folder_id", parentIds)`):
 * this helper grants no access, it only walks what the caller may see.
 */
export async function folderSubtreeIds(
  label: string,
  rootIds: string[],
  childrenOf: (parentIds: string[]) => unknown,
): Promise<string[]> {
  const children = await walkFolderGraph<{ id: string }>(
    rootIds,
    (parents) =>
      selectInBatches(label, parents, (batch) =>
        selectAllByKey<{ id: string }>(label, () => childrenOf(batch)),
      ),
    (child) => [child.id],
  );
  return [...new Set([...rootIds, ...children.map((child) => child.id)])];
}

/**
 * The folders of a subtree and every document filed in them, completely
 * (batched by folder, keyset-paged). `documentsIn(folderIds)` is the
 * caller's scoped document builder for a batch of folder ids.
 */
export async function readFolderSubtree<D extends { id: string }>(args: {
  label: string;
  rootId: string;
  childrenOf: (parentIds: string[]) => unknown;
  documentsIn: (folderIds: string[]) => unknown;
}): Promise<{ folderIds: string[]; documents: D[] }> {
  const folderIds = await folderSubtreeIds(args.label, [args.rootId], args.childrenOf);
  const documents = await selectInBatches<D>(args.label, folderIds, (batch) =>
    selectAllByKey<D & Record<string, unknown>>(args.label, () => args.documentsIn(batch)),
  );
  return { folderIds, documents };
}
