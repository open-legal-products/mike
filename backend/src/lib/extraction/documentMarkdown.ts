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
        // Strip tags until stable: a single pass leaves a reassembled tag
        // behind for adversarial nestings like "<scr<script>ipt>".
        let previous: string;
        do {
            previous = text;
            text = text.replace(/<[^>]+>/g, "");
        } while (text !== previous);
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
