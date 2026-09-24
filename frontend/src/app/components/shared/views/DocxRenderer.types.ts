export type DocxMode = "view" | "edit";

export interface DocxSurface {
    content: HTMLElement;
    scroll: HTMLElement;
    /** Materialize an off-screen match in engines that virtualize pages. */
    revealText?: (text: string) => boolean;
    /** Select and reveal a citation using the editor's native selection. */
    selectText?: (text: string) => boolean;
    /** Clear the citation selection without removing document content. */
    clearTextSelection?: () => void;
    exportDocx?: () => Promise<ArrayBuffer>;
}

export interface DocxRendererProps {
    bytes: ArrayBuffer;
    mode: DocxMode;
    filename?: string;
    onChange?: () => void;
    onSave?: (bytes?: ArrayBuffer) => void;
    onReady: (surface: DocxSurface) => void;
    onError: () => void;
}
