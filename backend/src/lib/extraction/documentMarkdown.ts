// Markdown views of source documents for tabular review. Parser-only imports:
// this module is loaded inside the isolated extraction worker.

import { docxToPdf, normalizeDocxZipPaths } from "../convert";
import {
    isPresentationDocumentType,
    isSpreadsheetDocumentType,
    isWordDocumentType,
} from "../documentTypes";
import { extractPresentationText } from "../officeText";
import { loadPdfjs } from "../pdfjs";
import { spreadsheetToLLMText } from "../spreadsheet";

/**
 * Route a document buffer to the right text extractor for its file type:
 * PDFs and DOCX extract directly; spreadsheets go through SheetJS; PPTX has a
 * native XML extractor; remaining Office types take the LibreOffice → PDF
 * detour.
 */
export async function extractDocumentMarkdown(
    buf: ArrayBuffer,
    fileType: string | null | undefined,
): Promise<string> {
    const normalizedType = (fileType ?? "").toLowerCase();
    if (normalizedType === "pdf") return extractPdfMarkdown(buf);
    if (normalizedType === "docx") return extractDocxMarkdown(buf);
    if (isSpreadsheetDocumentType(normalizedType)) {
        // SheetJS handles .xlsx/.xlsm/.xls directly, no PDF detour.
        return spreadsheetToLLMText(Buffer.from(buf));
    }
    if (normalizedType === "pptx") {
        return extractPresentationText(Buffer.from(buf));
    }
    if (
        isPresentationDocumentType(normalizedType) ||
        isWordDocumentType(normalizedType)
    ) {
        const pdfBuf = await docxToPdf(Buffer.from(buf));
        const pdfArrayBuffer = pdfBuf.buffer.slice(
            pdfBuf.byteOffset,
            pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer;
        return extractPdfMarkdown(pdfArrayBuffer);
    }
    return extractDocxMarkdown(buf);
}

export async function extractPdfMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const pdfjsLib = await loadPdfjs();
        const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) })
            .promise;
        const pages: string[] = [];
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const tc = await page.getTextContent();
            const text = tc.items
                .filter((it): it is { str: string } => "str" in it)
                .map((it) => it.str)
                .join(" ")
                .trim();
            if (text) pages.push(`## Page ${i}\n\n${text}`);
        }
        return pages.join("\n\n");
    } catch {
        return "";
    }
}

/**
 * Remove every `<…>` tag (one or more characters between the brackets) in
 * one linear scan, with exactly the matches of `text.replace(/<[^>]+>/g, "")`.
 *
 * Why not that regex: on a run of "<" with no ">" after it, the engine
 * retries from every "<" and scans to the end each time — quadratic, so a
 * crafted document of a few hundred KB of "<" stalls extraction for minutes.
 * Here each "<" asks indexOf for the next ">" once, and once there is none
 * nothing later can match either, so the rest is copied and the scan ends.
 *
 * Why one pass is enough (the old code repeated it "until stable"): a "<"
 * that survives is either directly followed by ">" or has no ">" anywhere
 * after it, and removing characters cannot change either fact, so the
 * output has no tag left to strip — "<scr<script>ipt>" becomes "ipt>" in
 * this one pass, exactly as the loop's fixed point.
 */
export function stripTags(text: string): string {
    let out = "";
    let from = 0;
    let open = text.indexOf("<");
    while (open !== -1) {
        const close = text.indexOf(">", open + 1);
        if (close === -1) break;
        if (close === open + 1) {
            // "<>" is not a tag; keep the "<" and look again after it.
            open = text.indexOf("<", open + 1);
            continue;
        }
        out += text.slice(from, open);
        from = close + 1;
        open = text.indexOf("<", from);
    }
    return out + text.slice(from);
}

export async function extractDocxMarkdown(buf: ArrayBuffer): Promise<string> {
    try {
        const mammoth = await import("mammoth");
        const normalized = await normalizeDocxZipPaths(Buffer.from(buf));
        const { value: html } = await mammoth.convertToHtml({
            buffer: normalized,
        });
        let text = html
            .replace(
                /<h([1-6])[^>]*>(.*?)<\/h\1>/gi,
                (_, l, t) => "#".repeat(Number(l)) + " " + t + "\n\n",
            )
            .replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**")
            .replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n")
            .replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");
        text = stripTags(text);
        return text
            .replace(/&nbsp;/g, " ")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            // Decode &amp; last so "&amp;lt;" yields the literal "&lt;"
            // instead of being double-unescaped into "<".
            .replace(/&amp;/g, "&")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    } catch {
        return "";
    }
}
