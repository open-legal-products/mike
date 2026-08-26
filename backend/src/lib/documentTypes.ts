export const ALLOWED_DOCUMENT_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
]);

export const ALLOWED_DOCUMENT_TYPES_LABEL =
  "pdf, docx, doc, xlsx, xlsm, xls, pptx, ppt";

// The lowercased extension of a filename, or "" when it has none.
export function documentSuffix(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
}

// Extension check every upload entry point performs before it touches
// storage. The `detail` string is the exact 400 body those routes already
// returned, so callers forward it verbatim and their wording is unchanged.
export function parseAllowedSuffix(
  filename: string,
): { ok: true; suffix: string } | { ok: false; detail: string } {
  const suffix = documentSuffix(filename);
  if (!ALLOWED_DOCUMENT_TYPES.has(suffix)) {
    return {
      ok: false,
      detail: `Unsupported file type: ${suffix}. Allowed: ${ALLOWED_DOCUMENT_TYPES_LABEL}`,
    };
  }
  return { ok: true, suffix };
}

const WORD_TYPES = new Set(["docx", "doc"]);
const SPREADSHEET_TYPES = new Set(["xlsx", "xlsm", "xls"]);
const PRESENTATION_TYPES = new Set(["pptx", "ppt"]);

export function isWordDocumentType(fileType: string | null | undefined) {
  return WORD_TYPES.has((fileType ?? "").toLowerCase());
}

export function isSpreadsheetDocumentType(fileType: string | null | undefined) {
  return SPREADSHEET_TYPES.has((fileType ?? "").toLowerCase());
}

export function isPresentationDocumentType(fileType: string | null | undefined) {
  return PRESENTATION_TYPES.has((fileType ?? "").toLowerCase());
}

export function shouldConvertToPdf(fileType: string | null | undefined) {
  const normalized = (fileType ?? "").toLowerCase();
  // Spreadsheets are intentionally excluded: they are rendered natively as a
  // grid in the frontend (Fortune-sheet) from the raw file bytes rather than a
  // PDF rendition, which clipped wide/large sheets.
  return (
    isWordDocumentType(normalized) || isPresentationDocumentType(normalized)
  );
}

/**
 * The types whose text can only be read by round-tripping the file through
 * LibreOffice. Every other allowed type has an in-process reader — docx via
 * the tracked-changes extractor (mammoth as fallback), pptx via officeText,
 * spreadsheets via SheetJS, pdf via pdfjs — so .doc and .ppt are the only
 * ones read_document pays a subprocess conversion for, and therefore the only
 * ones worth precomputing and caching.
 */
export function requiresLibreOfficeTextExtraction(
  fileType: string | null | undefined,
) {
  const normalized = (fileType ?? "").toLowerCase();
  return normalized === "doc" || normalized === "ppt";
}

export function contentTypeForDocumentType(fileType: string | null | undefined) {
  switch ((fileType ?? "").toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case "xls":
      return "application/vnd.ms-excel";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    default:
      return "application/octet-stream";
  }
}
