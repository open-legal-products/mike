import { normalizePdfQuoteText } from "./pdfQuoteSearch";
let pdfjsLib: typeof import("pdfjs-dist") | null = null;

export async function getPdfJs() {
    if (pdfjsLib) return pdfjsLib;
    pdfjsLib = await import("pdfjs-dist");
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
    ).toString();
    return pdfjsLib;
}

export const STANDARD_FONT_DATA_URL =
    "https://unpkg.com/pdfjs-dist@4.10.38/standard_fonts/";

const HIGHLIGHT_CLASS = "pdf-text-highlight";
const ORIGINAL_TEXT_ATTR = "data-original-text";

// Strip everything except alphanumerics (a-z A-Z 0-9) for robust matching
function onlyLetters(s: string): string {
    return normalizePdfQuoteText(s);
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// Given a position in the stripped (letters-only) version of `original`,
// return the corresponding index in `original`.
function strippedPosToOriginal(original: string, strippedPos: number): number {
    let count = 0;
    for (let i = 0; i < original.length; i++) {
        if (/[a-zA-Z0-9]/.test(original[i])) {
            if (count === strippedPos) return i;
            count++;
        }
    }
    return original.length;
}

const highlightedDivs = new WeakMap<HTMLElement[], Set<HTMLElement>>();
export function clearHighlights(textDivs: HTMLElement[]) {
    for (const div of highlightedDivs.get(textDivs) ?? []) {
        div.textContent = div.getAttribute(ORIGINAL_TEXT_ATTR)!;
        div.removeAttribute(ORIGINAL_TEXT_ATTR);
    }
    highlightedDivs.delete(textDivs);
}

function buildTextIndex(textDivs: HTMLElement[], order?: readonly number[]) {
    const divOrigTexts = new Array<string>(textDivs.length).fill("");
    const divStripped = new Array<string>(textDivs.length).fill("");
    const divStartInFull = new Array<number>(textDivs.length).fill(0);
    const readingOrder = order ?? textDivs.map((_, index) => index);
    const parts: string[] = [];
    let length = 0;
    for (const i of readingOrder) {
        const original = textDivs[i]?.getAttribute(ORIGINAL_TEXT_ATTR) ?? textDivs[i]?.textContent ?? "";
        divOrigTexts[i] = original;
        divStripped[i] = onlyLetters(original);
        divStartInFull[i] = length;
        parts.push(divStripped[i]);
        length += divStripped[i].length;
    }
    return {order, readingOrder, divOrigTexts, divStripped, divStartInFull, fullStripped:parts.join("")};
}
const indexes = new WeakMap<HTMLElement[], ReturnType<typeof buildTextIndex>>();

/**
 * Wrap the part of the text layer matching `quote` in a highlight span.
 *
 * `order` lists indices into `textDivs` in reading order, as produced by
 * `computeReadingOrder`. It matters because the backend reorders PDF text
 * items into reading order before the model ever sees them, so a quote's
 * characters are contiguous in *that* order — not in `textDivs`, which is in
 * the content stream's drawing order. On a table drawn column by column the
 * two disagree, and a quote reading across a row would never be found. Omit
 * it to match in drawing order.
 */
export async function highlightQuote(
    textDivs: HTMLElement[],
    quote: string,
    order?: readonly number[],
): Promise<boolean> {
    clearHighlights(textDivs);

    // Split on ellipsis variants to highlight each segment separately
    const segments = quote
        .split(/\.{3}|…/)
        .map((s) => onlyLetters(s))
        .filter((s) => s.length > 0);

    let indexed = indexes.get(textDivs);
    if (!indexed || indexed.order !== order) {
        indexed = buildTextIndex(textDivs, order);
        indexes.set(textDivs, indexed);
    }
    const { readingOrder, divOrigTexts, divStripped, divStartInFull, fullStripped } = indexed;

    // Map: divIndex -> [strippedLocalStart, strippedLocalEnd]
    const divHighlightRanges = new Map<number, [number, number]>();

    for (const segment of segments) {
        const searchKey = segment.slice(0, 30);
        const matchPos = fullStripped.indexOf(searchKey);
        if (matchPos === -1) {
            continue;
        }
        const matchEnd = matchPos + segment.length;

        // Binary-search the first intersecting span instead of scanning all
        // spans for every quote segment.
        let low = 0, high = readingOrder.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            const i = readingOrder[middle];
            if (divStartInFull[i] + divStripped[i].length <= matchPos) low = middle + 1;
            else high = middle;
        }
        for (let position = low; position < readingOrder.length; position++) {
            const i = readingOrder[position];
            const divStart = divStartInFull[i];
            const divEnd = divStart + divStripped[i].length;
            if (matchEnd <= divStart) break;
            if (matchPos >= divEnd) continue;

            const localStart = Math.max(0, matchPos - divStart);
            const localEnd = Math.min(
                divStripped[i].length,
                matchEnd - divStart,
            );
            divHighlightRanges.set(i, [localStart, localEnd]);
        }
    }

    if (divHighlightRanges.size === 0) return false;

    const changed = new Set<HTMLElement>();
    highlightedDivs.set(textDivs, changed);
    for (const [idx, [strStart, strEnd]] of divHighlightRanges) {
        const div = textDivs[idx];
        const orig = divOrigTexts[idx];

        // Map stripped positions back to original character positions
        const origStart = strippedPosToOriginal(orig, strStart);
        const origEnd = strippedPosToOriginal(orig, strEnd);

        changed.add(div);
        div.setAttribute(ORIGINAL_TEXT_ATTR, orig);
        div.innerHTML =
            escapeHtml(orig.slice(0, origStart)) +
            `<span class="${HIGHLIGHT_CLASS}">${escapeHtml(orig.slice(origStart, origEnd))}</span>` +
            escapeHtml(orig.slice(origEnd));
    }

    return true;
}
