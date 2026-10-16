import type { Project } from "@/app/components/shared/types";
import { notifyError } from "@/app/lib/userFacingError";

export type ProjectTreeItemKind = "doc" | "folder";

type ProjectSetter = (update: (current: Project | null) => Project | null) => void;

function parentOf(
    project: Project | null,
    kind: ProjectTreeItemKind,
    id: string,
): string | null | undefined {
    if (!project) return undefined;
    if (kind === "doc") {
        const doc = (project.documents ?? []).find((d) => d.id === id);
        return doc ? (doc.folder_id ?? null) : undefined;
    }
    const folder = (project.folders ?? []).find((f) => f.id === id);
    return folder ? (folder.parent_folder_id ?? null) : undefined;
}

/**
 * Re-parent one document or folder in a loaded project. `onlyFrom` makes the
 * change conditional on the item's current parent, so a revert never
 * clobbers a later move of the same item.
 */
export function withItemParent(
    project: Project | null,
    kind: ProjectTreeItemKind,
    id: string,
    parentId: string | null,
    onlyFrom?: string | null,
): Project | null {
    if (!project) return project;
    if (onlyFrom !== undefined && parentOf(project, kind, id) !== onlyFrom) {
        return project;
    }
    if (kind === "doc") {
        return {
            ...project,
            documents: (project.documents ?? []).map((d) =>
                d.id === id ? { ...d, folder_id: parentId } : d,
            ),
        };
    }
    return {
        ...project,
        folders: (project.folders ?? []).map((f) =>
            f.id === id ? { ...f, parent_folder_id: parentId } : f,
        ),
    };
}

/**
 * Move a project document or folder optimistically.
 *
 * The tree shows the item in its new place at once. If the request fails,
 * only that item goes back to where it was (and only if nothing has moved it
 * since), then the error is rethrown so the caller can report it — the
 * screen never shows a move that did not happen.
 */
export async function moveProjectItemOptimistically({
    project,
    setProject,
    kind,
    id,
    targetFolderId,
    request,
}: {
    project: Project | null;
    setProject: ProjectSetter;
    kind: ProjectTreeItemKind;
    id: string;
    targetFolderId: string | null;
    request: () => Promise<unknown>;
}): Promise<void> {
    const previousParent = parentOf(project, kind, id);
    setProject((current) => withItemParent(current, kind, id, targetFolderId));
    try {
        await request();
    } catch (error) {
        if (previousParent !== undefined) {
            setProject((current) =>
                withItemParent(current, kind, id, previousParent, targetFolderId),
            );
        }
        throw error;
    }
}

/**
 * Tell the user a document or folder move failed, with a Retry that re-runs
 * it. One place for the sentence, shared by the explorer's own drop targets
 * and the project page's root drop target.
 */
export function notifyMoveFailure(
    kind: ProjectTreeItemKind,
    id: string,
    error: unknown,
    retry: () => void | Promise<void>,
): void {
    notifyError(error, {
        action: kind === "doc" ? "move this document" : "move this folder",
        dedupeKey: `explorer-move-${kind}:${id}`,
        onRetry: retry,
    });
}
