type DragTypes = Pick<DataTransfer, "types">;

export function isDocumentViewerDrag(dataTransfer: DragTypes): boolean {
    return (
        isExternalFileDrag(dataTransfer) ||
        dataTransfer.types.includes("application/mike-doc") ||
        dataTransfer.types.includes("application/mike-docs")
    );
}

export function isProjectItemDrag({ types }: DragTypes): boolean {
    return (
        types.includes("application/mike-doc") ||
        types.includes("application/mike-folder")
    );
}

export function isExternalFileDrag({ types }: DragTypes): boolean {
    return types.includes("Files");
}

export function isChatAttachmentDrag(dataTransfer: DragTypes): boolean {
    return (
        isExternalFileDrag(dataTransfer) ||
        dataTransfer.types.includes("application/mike-doc")
    );
}
