// The parsers the isolated extraction process may run, by name. Everything here
// does CPU-bound work on the whole file, so it runs outside the calling process (see
// isolated.ts). Keep imports parser-only: this module is all the parser process loads.

import { extractDocxBodyText } from "../docxTrackedChanges";
import { extractPresentationText } from "../officeText";
import { extractLegacyOfficeText, extractPdfTextForModel } from "../pdfText";
import { spreadsheetToLLMText } from "../spreadsheet";
import { extractDocumentMarkdown } from "./documentMarkdown";
import { extractDocumentText } from "./documentText";

async function mammothRawText(bytes: ArrayBuffer): Promise<string> {
  const mammoth = await import("mammoth");
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
}

export const EXTRACTION_OPS = {
  /** Search index text (document.extract_text). */
  documentText: (bytes: ArrayBuffer, fileType: string) =>
    extractDocumentText(bytes, fileType),
  /** Tabular review source markdown. */
  documentMarkdown: (bytes: ArrayBuffer, fileType: string) =>
    extractDocumentMarkdown(bytes, fileType),
  /** read_document views, one per file type. */
  pdfForModel: (bytes: ArrayBuffer) => extractPdfTextForModel(bytes),
  // The same accepted view the edit_document matcher anchors against, with
  // mammoth as the fallback when it comes back empty.
  docxText: async (bytes: ArrayBuffer) =>
    (await extractDocxBodyText(Buffer.from(bytes))) || mammothRawText(bytes),
  spreadsheet: async (bytes: ArrayBuffer) =>
    spreadsheetToLLMText(Buffer.from(bytes)),
  presentation: (bytes: ArrayBuffer) =>
    extractPresentationText(Buffer.from(bytes)),
  legacyOfficeText: (bytes: ArrayBuffer) => extractLegacyOfficeText(bytes),
  rawText: (bytes: ArrayBuffer) => mammothRawText(bytes),
};

export type ExtractionOps = typeof EXTRACTION_OPS;
export type ExtractionOp = keyof ExtractionOps;
