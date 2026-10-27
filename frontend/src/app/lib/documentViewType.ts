export type DocumentViewType = "pdf" | "docx" | "spreadsheet" | "visual";

type LegacyDocViewType = Extract<DocumentViewType, "pdf" | "docx">;

export interface ResolveDocumentViewTypeOptions {
  filename?: string | null;
  fileType?: string | null;
  /** Legacy .doc files require a PDF rendition because DocxView cannot parse them. */
  legacyDocViewType?: LegacyDocViewType;
  /** Some stored Word documents have a generated PDF preview. */
  preferPdfForWord?: boolean;
}

type DocumentTypeToken =
  "pdf" | "doc" | "docx" | "spreadsheet" | "presentation" | "visual" | "other";

function documentTypeToken(
  value: string | null | undefined,
): DocumentTypeToken {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized) return "other";

  if (normalized.includes("spreadsheet") || normalized.includes("ms-excel")) {
    return "spreadsheet";
  }
  if (normalized.includes("wordprocessing") || normalized.includes("msword")) {
    return normalized.includes("openxml") ? "docx" : "doc";
  }
  if (normalized.includes("presentation")) return "presentation";
  if (normalized === "application/pdf") return "pdf";
  if (normalized === "text/html") return "visual";

  const withoutQuery = normalized.split(/[?#]/, 1)[0];
  const token = withoutQuery.includes(".")
    ? (withoutQuery.split(".").pop() ?? "")
    : withoutQuery;

  if (token === "xlsx" || token === "xlsm" || token === "xls") {
    return "spreadsheet";
  }
  if (token === "docx" || token === "word") return "docx";
  if (token === "doc") return "doc";
  if (token === "pptx" || token === "ppt") return "presentation";
  if (token === "pdf") return "pdf";
  if (token === "html" || token === "htm") return "visual";
  return "other";
}

/**
 * Resolve the shared viewer used for a document-like asset. Unsupported and
 * presentation formats fall back to PdfView because the backend supplies a
 * PDF rendition for those formats where required.
 */
export function resolveDocumentViewType({
  filename,
  fileType,
  legacyDocViewType = "pdf",
  preferPdfForWord = false,
}: ResolveDocumentViewTypeOptions): DocumentViewType {
  const fileTypeToken = documentTypeToken(fileType);
  const filenameToken = documentTypeToken(filename);

  if (fileTypeToken === "spreadsheet" || filenameToken === "spreadsheet") {
    return "spreadsheet";
  }
  if (fileTypeToken === "visual" || filenameToken === "visual") {
    return "visual";
  }

  const wordToken =
    fileTypeToken === "doc" || fileTypeToken === "docx"
      ? fileTypeToken
      : filenameToken === "doc" || filenameToken === "docx"
        ? filenameToken
        : null;
  if (wordToken) {
    if (preferPdfForWord) return "pdf";
    return wordToken === "doc" ? legacyDocViewType : "docx";
  }

  return "pdf";
}
