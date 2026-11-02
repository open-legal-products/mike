/**
 * Warning for a PDF whose pages carry no text layer (scanned without OCR). The
 * assistant reads PDFs through their text layer only, so those pages are
 * invisible to it even though the viewer shows them. Null when there is
 * nothing to warn about, including versions that were never measured.
 */
export function textLayerWarning(
    pageCount: number | null | undefined,
    textlessPageCount: number | null | undefined,
): string | null {
    if (!textlessPageCount || textlessPageCount < 1) return null;
    if (pageCount != null && textlessPageCount >= pageCount) {
        return "No text layer: this PDF looks scanned, so the assistant cannot read it. Run OCR on it and upload it again.";
    }
    const pages =
        pageCount != null
            ? `${textlessPageCount} of ${pageCount} pages`
            : `${textlessPageCount} ${textlessPageCount === 1 ? "page" : "pages"}`;
    const verb = textlessPageCount === 1 ? "has" : "have";
    const pronoun = textlessPageCount === 1 ? "it" : "them";
    return `${pages} ${verb} no text layer (likely scanned), so the assistant cannot read ${pronoun}.`;
}
