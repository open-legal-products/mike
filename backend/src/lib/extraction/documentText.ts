import { extractDocxBodyText } from "../docxTrackedChanges";
import { extractPdfTextForIndex } from "../pdfText";
import { docxToPdf } from "../convert";
import { extractPresentationText } from "../officeText";
import { spreadsheetToLLMText } from "../spreadsheet";
import { isSpreadsheetDocumentType, requiresLibreOfficeTextExtraction } from "../documentTypes";

/** Complete text, using the same accepted DOCX view as the edit matcher. */
export async function extractDocumentText(raw: ArrayBuffer, fileType: string) {
  const type = fileType.toLowerCase();
  if (type === "pdf") return extractPdfTextForIndex(raw);
  if (requiresLibreOfficeTextExtraction(type)) {
    const pdf = await docxToPdf(Buffer.from(raw));
    return extractPdfTextForIndex(Uint8Array.from(pdf).buffer);
  }
  let text: string;
  if (type === "docx") {
    text = await extractDocxBodyText(Buffer.from(raw));
    if (!text) text = (await (await import("mammoth")).extractRawText({ buffer: Buffer.from(raw) })).value;
  } else if (isSpreadsheetDocumentType(type)) {
    text = spreadsheetToLLMText(Buffer.from(raw));
  } else if (type === "pptx") {
    text = await extractPresentationText(Buffer.from(raw));
  } else {
    throw new Error("document_text_unsupported_format");
  }
  return { text, textlessPageCount: null };
}
