export interface DocxSurface {
    content: HTMLElement;
    scroll: HTMLElement;
    /** Materialize an off-screen match in engines that virtualize pages. */
    revealText?: (text: string) => boolean;
}

export interface DocxRendererProps {
    bytes: ArrayBuffer;
    onReady: (surface: DocxSurface) => void;
    onError: () => void;
}
