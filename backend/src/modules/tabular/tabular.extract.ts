// Extraction for the tabular-review module: the LLM cell-extraction helpers
// and document (PDF/DOCX/Office) text extraction.

import { docxToPdf, normalizeDocxZipPaths } from "../../lib/convert";
import {
    isPresentationDocumentType,
    isSpreadsheetDocumentType,
    isWordDocumentType,
} from "../../lib/documentTypes";
import { extractPresentationText } from "../../lib/officeText";
import { spreadsheetToLLMText } from "../../lib/spreadsheet";
import {
    completeText,
    streamChatWithTools,
    type UserApiKeys,
} from "../../lib/llm";
import { loadPdfjs } from "../../lib/pdfjs";
import { formatPromptSuffix } from "./tabular.prompt";
import { type CellResult, type Column } from "./tabular.shared";

// ---------------------------------------------------------------------------
// LLM extraction helpers
// ---------------------------------------------------------------------------

export async function queryTabularCell(
    model: string,
    filename: string,
    documentText: string,
    columnPrompt: string,
    format?: string,
    tags?: string[],
    apiKeys?: UserApiKeys,
): Promise<CellResult | null> {
    const suffix = formatPromptSuffix(format as never, tags);
    const fullPrompt = `${columnPrompt}${suffix} If not found, state "Not Found". Leave all reasoning and explanation in the "reasoning" field only.`;

    const EXTRACTION_SYSTEM = `You are a legal document analyst. Return ONLY valid JSON:
{"summary": string, "flag": "green"|"grey"|"yellow"|"red", "reasoning": string}

The "summary" and "reasoning" field values may use markdown formatting (bullets, bold, italics, etc.) — the values are still plain JSON strings (escape newlines as \\n), but the text inside will be rendered as markdown in the UI.

The "summary" field must contain only the extracted value with inline citations — no explanation or reasoning. Every factual claim in "summary" must be followed immediately by a citation in the format [[document:SOURCE_DOCUMENT_ID||page:N||quote:exact quoted text]], using the exact source document ID shown before the supporting document. For spreadsheets, use [[document:SOURCE_DOCUMENT_ID||sheet:SHEET_NAME||cell:A1||quote:exact cell text]]. The quote must be a short verbatim excerpt (≤ 25 words) narrowly scoped to the specific claim. Do not have multiple claims share the same long quote; if two different statements need different evidence, give each its own short, precise quote. All reasoning and explanation belongs in "reasoning" only, which may also contain citations.`;

    let raw: string;
    try {
        raw = await completeText({
            model,
            systemPrompt: EXTRACTION_SYSTEM,
            user: `Document: ${filename}\n\n${documentText}\n\n---\nInstruction: ${fullPrompt}`,
            maxTokens: 2048,
            apiKeys,
        });
    } catch (err) {
        console.error("[queryTabularCell] completion failed", err);
        return null;
    }
    try {
        const parsed = JSON.parse(
            raw
                .replace(/^```(?:json)?\n?/i, "")
                .replace(/\n?```$/, "")
                .trim(),
        ) as {
            summary?: unknown;
            value?: unknown;
            flag?: unknown;
            reasoning?: unknown;
        };
        return {
            summary:
                String(parsed.summary ?? parsed.value ?? "").trim() ||
                "Not addressed",
            flag: (["green", "grey", "yellow", "red"] as const).includes(
                parsed.flag as "green",
            )
                ? (parsed.flag as "green")
                : "grey",
            reasoning: String(parsed.reasoning ?? ""),
        };
    } catch {
        return raw.trim()
            ? {
                  summary: raw.trim().slice(0, 500),
                  flag: "grey" as const,
                  reasoning: "",
              }
            : null;
    }
}

export async function generateChatTitle(
    model: string,
    firstUserMessage: string,
    context?: { reviewTitle?: string | null; projectName?: string | null },
    apiKeys?: UserApiKeys,
): Promise<string | null> {
    try {
        const contextLines: string[] = [];
        if (context?.projectName)
            contextLines.push(`Project: ${context.projectName}`);
        if (context?.reviewTitle)
            contextLines.push(`Tabular review: ${context.reviewTitle}`);
        const contextBlock = contextLines.length
            ? `This chat is in the context of a tabular review.\n${contextLines.join("\n")}\n\n`
            : "";

        const raw = await completeText({
            model,
            user: `${contextBlock}Generate a short title (4-6 words) for a chat that starts with the message below. The title should reflect the user's specific question, not the review or project name. Return only the title, no punctuation, no quotes:\n\n${firstUserMessage}`,
            maxTokens: 64,
            apiKeys,
        });
        return raw.trim().slice(0, 80) || null;
    } catch {
        return null;
    }
}

export async function queryTabularAllColumns(
    model: string,
    filename: string,
    documentText: string,
    columns: Column[],
    onResult: (columnIndex: number, result: CellResult) => Promise<void>,
    apiKeys?: UserApiKeys,
    abortSignal?: AbortSignal,
): Promise<void> {
    const columnsDesc = columns
        .map((col) => {
            const suffix = formatPromptSuffix(col.format as never, col.tags);
            const fullPrompt = `${col.prompt}${suffix} If not found, state "Not Found".`;
            return `Column ${col.index} — "${col.name}": ${fullPrompt}`;
        })
        .join("\n");

    const SYSTEM = `You are a legal document analyst. Extract information for each column listed below.

For each column, output exactly one minified JSON object on its own line (no line breaks inside the JSON), then a newline. Process columns in order and output each result as soon as you finish it.

Line format:
{"column_index": <N>, "summary": <string>, "flag": <"green"|"grey"|"yellow"|"red">, "reasoning": <string>}

Rules:
- "summary": the extracted value with inline citations [[document:SOURCE_DOCUMENT_ID||page:N||quote:verbatim excerpt ≤25 words]] after every factual claim, using the exact source document ID shown before the supporting document. For spreadsheets, use [[document:SOURCE_DOCUMENT_ID||sheet:SHEET_NAME||cell:A1||quote:exact cell text]]. No explanation or reasoning here. Quotes must be narrowly scoped to the specific claim — extract only the exact supporting words, not the full surrounding sentence. Do not reuse one long quote across multiple statements; give each claim its own short, precise quote.
- "flag": green = standard/favorable, yellow = needs attention, red = problematic/unfavorable, grey = neutral/not found
- "reasoning": brief explanation of the extraction
- The "summary" and "reasoning" string VALUES may use markdown (bullets, bold, italics, etc.) — escape newlines as \\n inside the JSON string. This markdown is rendered in the UI.
- Output ONLY the JSON lines themselves. Do NOT wrap the response in markdown code fences (e.g. \`\`\`json), and do not add any preamble or summary.`;

    const USER = `Document: ${filename}\n\n${documentText}\n\n---\nColumns to extract:\n${columnsDesc}`;

    let contentBuffer = "";
    const pending: Promise<unknown>[] = [];

    const processLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed) as {
                column_index?: unknown;
                summary?: unknown;
                flag?: unknown;
                reasoning?: unknown;
            };
            if (typeof parsed.column_index !== "number") return;
            const col = columns.find((c) => c.index === parsed.column_index);
            if (!col) return;
            await onResult(parsed.column_index, {
                summary: String(parsed.summary ?? "").trim() || "Not addressed",
                flag: (["green", "grey", "yellow", "red"] as const).includes(
                    parsed.flag as "green",
                )
                    ? (parsed.flag as CellResult["flag"])
                    : "grey",
                reasoning: String(parsed.reasoning ?? ""),
            });
        } catch {
            // malformed line — skip
        }
    };

    // An aborted stream is not a failure to log — it is the caller stopping the
    // run (client disconnect, or the generation lease being lost). Re-thrown
    // after the buffered lines drain so the caller can tell "stopped" apart
    // from "the model just didn't answer".
    let abortError: unknown;
    try {
        await streamChatWithTools({
            model,
            systemPrompt: SYSTEM,
            messages: [{ role: "user", content: USER }],
            tools: [],
            apiKeys,
            abortSignal,
            callbacks: {
                onContentDelta: (delta) => {
                    contentBuffer += delta;
                    let newlineIdx: number;
                    while ((newlineIdx = contentBuffer.indexOf("\n")) !== -1) {
                        const completedLine = contentBuffer.slice(
                            0,
                            newlineIdx,
                        );
                        contentBuffer = contentBuffer.slice(newlineIdx + 1);
                        pending.push(processLine(completedLine));
                    }
                },
            },
        });
    } catch (err) {
        if (abortSignal?.aborted) {
            abortError = err;
        } else {
            console.error("[queryTabularAllColumns] stream failed", err);
        }
    }

    if (contentBuffer.trim()) pending.push(processLine(contentBuffer));
    await Promise.all(pending);
    if (abortError) throw abortError;
}

// ---------------------------------------------------------------------------
// Document text extraction
// ---------------------------------------------------------------------------

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
