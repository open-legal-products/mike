import type { Image } from "@fortune-sheet/core";

type ImportedImage = Partial<Image> & {
    default?: Partial<Image>;
    originWidth?: number;
    originHeight?: number;
};

/** LuckyExcel uses keyed images and nested geometry; Fortune-sheet uses a flat array. */
export function normalizeSpreadsheetImages(images: unknown): Image[] {
    if (Array.isArray(images)) return images as Image[];
    if (!images || typeof images !== "object") return [];

    return Object.entries(images).flatMap(([key, value]) => {
        if (!value || typeof value !== "object") return [];
        const image = value as ImportedImage;
        if (typeof image.src !== "string" || !image.src) return [];
        const width = image.width ?? image.default?.width ?? image.originWidth;
        const height =
            image.height ?? image.default?.height ?? image.originHeight;
        if (
            typeof width !== "number" ||
            !Number.isFinite(width) ||
            typeof height !== "number" ||
            !Number.isFinite(height)
        )
            return [];
        return [
            {
                id: image.id ?? `spreadsheet-image-${key}`,
                src: image.src,
                width,
                height,
                left: image.left ?? image.default?.left ?? 0,
                top: image.top ?? image.default?.top ?? 0,
            },
        ];
    });
}
