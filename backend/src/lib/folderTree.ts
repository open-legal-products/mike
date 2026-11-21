// Scope-independent folder rules. Callers supply only folders (or a loader)
// already restricted to their project or library; this module grants no access.
export function parseFolderPath(body: {
  segments?: unknown;
  base_folder_id?: unknown;
  conflict_resolution?: unknown;
}) {
  if (!Array.isArray(body.segments)) return null;
  const segments = body.segments
    .filter((segment): segment is string => typeof segment === "string")
    .map((segment) => segment.trim());
  if (
    segments.length !== body.segments.length ||
    !segments.length ||
    segments.length > 100 ||
    segments.some((segment) => !segment || segment.length > 255)
  )
    return null;
  const conflictResolution =
    body.conflict_resolution === "reuse" ||
    body.conflict_resolution === "rename"
      ? body.conflict_resolution
      : "error";
  const baseFolderId =
    typeof body.base_folder_id === "string" && body.base_folder_id.trim()
      ? body.base_folder_id.trim()
      : null;
  return { segments, conflictResolution, baseFolderId };
}

export async function validateFolderMove(
  folderId: string,
  parentFolderId: string,
  loadFolder: (
    id: string,
  ) => Promise<{ parent_folder_id: string | null } | null>,
): Promise<"cycle" | "parent_not_found" | null> {
  const visited = new Set<string>();
  let current: string | null = parentFolderId;
  while (current) {
    if (current === folderId || visited.has(current)) return "cycle";
    visited.add(current);
    const parent = await loadFolder(current);
    if (!parent) return "parent_not_found";
    current = parent.parent_folder_id ?? null;
  }
  return null;
}

/**
 * Breadth-first walk of a folder graph one level per round trip, instead of
 * loading every folder in a scope to find a few. `loadLevel` receives the
 * current frontier (callers batch and scope it); `nextIds` names the rows to
 * visit next — parents for an ancestor walk, the row itself for a
 * children-by-parent walk. Visited ids are never revisited, so a corrupt
 * parent cycle ends the walk instead of looping. Returns every loaded row.
 */
export async function walkFolderGraph<T extends { id: string }>(
  startIds: Iterable<string | null | undefined>,
  loadLevel: (ids: string[]) => Promise<T[]>,
  nextIds: (row: T) => Array<string | null | undefined>,
): Promise<T[]> {
  const seen = new Set<string>();
  const rows: T[] = [];
  const unseen = (ids: Iterable<string | null | undefined>) =>
    [...new Set([...ids].filter((id): id is string => !!id && !seen.has(id)))];
  let frontier = unseen(startIds);
  while (frontier.length) {
    for (const id of frontier) seen.add(id);
    const level = await loadLevel(frontier);
    rows.push(...level);
    frontier = unseen(level.flatMap(nextIds));
  }
  return rows;
}

/**
 * Resolve folder ids to "Parent / Child" display paths. Each folder's path is
 * computed once and reused by every descendant, so labelling D documents in a
 * tree of depth H costs O(folders + D) instead of O(D·H), and a corrupt
 * parent cycle ends the walk instead of looping forever. A folder missing from
 * `folders` (outside the caller's scope) ends the path, as the root does.
 */
export function folderPathResolver(
  folders: Iterable<{ id: string; name: string; parent_folder_id: string | null }>,
): (folderId: string | null) => string {
  const byId = new Map<string, { name: string; parent_folder_id: string | null }>();
  for (const folder of folders) byId.set(folder.id, folder);
  // null = a folder outside the map: contributes no segment.
  const memo = new Map<string, string>();
  return (folderId) => {
    if (!folderId) return "";
    const chain: string[] = [];
    const onChain = new Set<string>();
    let base: string | null = null;
    let current: string | null = folderId;
    while (current) {
      const cached = memo.get(current);
      if (cached !== undefined) {
        base = cached;
        break;
      }
      const folder = byId.get(current);
      if (!folder || onChain.has(current)) break;
      onChain.add(current);
      chain.push(current);
      current = folder.parent_folder_id;
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const name = byId.get(chain[i])!.name;
      base = base === null ? name : `${base} / ${name}`;
      memo.set(chain[i], base);
    }
    return base ?? "";
  };
}
