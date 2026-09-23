export type DocxMode = "view" | "edit";

export interface DocxSurface {
    content: HTMLElement;
    scroll: HTMLElement;
    /** Materialize an off-screen match in engines that virtualize pages. */
    revealText?: (text: string) => boolean;
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
