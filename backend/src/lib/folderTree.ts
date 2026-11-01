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
