export type DocxMode = "view" | "edit" | "suggesting";

export interface DocxSaveState {
    ready: boolean;
    dirty: boolean;
    status: "idle" | "pending" | "saving" | "saved" | "error";
    error: string | null;
}

/** The `w:id`s of one Mike edit's insertion and deletion halves. */
export interface DocxRevisionIds {
    ins?: string | null;
    del?: string | null;
}

export interface DocxSurface {
    content: HTMLElement;
    scroll: HTMLElement;
    /** Activate and reveal a tracked change using the native review highlight. */
    activateRevision?: (ids: DocxRevisionIds) => boolean;
    /** Dismiss only the revision activated by this viewer. */
    clearRevisionHighlight?: () => void;
    /** Select and reveal a citation using the editor's native selection. */
    selectText?: (text: string) => boolean;
    /** Clear the citation selection without removing document content. */
    clearTextSelection?: () => void;
    exportDocx?: () => Promise<ArrayBuffer>;
}

export interface DocxRendererProps {
    bytes: ArrayBuffer;
    mode: DocxMode;
    /** False hides formatting controls and enforces native read-only mode without reloading. */
    toolbarVisible?: boolean;
    filename?: string;
    author?: string;
    onChange?: () => void;
    onSave?: (bytes?: ArrayBuffer) => void;
    onReady: (surface: DocxSurface) => void;
    onError: () => void;
}
