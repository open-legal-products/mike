import type { Folder } from "../components/shared/types";

export type PendingDeleteFolder = {
    folder: Folder;
    folderIds: string[];
    documentIds: string[];
    documentCount: number;
};

export type FolderDeleteDialogState = {
    pending: PendingDeleteFolder | null;
    status: "idle" | "deleting" | "deleted";
};

export const INITIAL_FOLDER_DELETE_DIALOG_STATE: FolderDeleteDialogState = {
    pending: null,
    status: "idle",
};

export type FolderDeleteDialogAction =
    | { type: "request"; pending: PendingDeleteFolder }
    | { type: "start"; folderId: string }
    | { type: "complete"; folderId: string }
    | { type: "failed"; folderId: string }
    | { type: "cancel" }
    | { type: "dismiss-completed"; folderId: string };

export function folderDeleteDialogReducer(
    state: FolderDeleteDialogState,
    action: FolderDeleteDialogAction,
): FolderDeleteDialogState {
    switch (action.type) {
        case "request":
            return { pending: action.pending, status: "idle" };
        case "start":
            return state.pending?.folder.id === action.folderId
                ? { ...state, status: "deleting" }
                : state;
        case "complete":
            return state.pending?.folder.id === action.folderId
                ? { ...state, status: "deleted" }
                : state;
        case "failed":
            return state.pending?.folder.id === action.folderId
                ? { ...state, status: "idle" }
                : state;
        case "cancel":
            return state.status === "deleting"
                ? state
                : INITIAL_FOLDER_DELETE_DIALOG_STATE;
        case "dismiss-completed":
            return state.status === "deleted" &&
                state.pending?.folder.id === action.folderId
                ? INITIAL_FOLDER_DELETE_DIALOG_STATE
                : state;
    }
}

export function removeDeletedDocumentTabs<T extends { documentId: string }>(
    tabs: T[],
    deletedDocumentIds: ReadonlySet<string>,
): T[] {
    return tabs.filter(
        (tab) => !deletedDocumentIds.has(tab.documentId),
    );
}

export function clearDeletedDocumentId(
    documentId: string | null,
    deletedDocumentIds: ReadonlySet<string>,
): string | null {
    return documentId && deletedDocumentIds.has(documentId)
        ? null
        : documentId;
}
