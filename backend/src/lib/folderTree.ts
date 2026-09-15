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

export function collectFolderSubtree(
  folderId: string,
  folders: Array<{ id: string; parent_folder_id: string | null }>,
): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parent_folder_id) continue;
    const children = childrenByParent.get(folder.parent_folder_id) ?? [];
    children.push(folder.id);
    childrenByParent.set(folder.parent_folder_id, children);
  }
  const selected = new Set<string>();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop()!;
    if (selected.has(id)) continue;
    selected.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }
  return selected;
}
