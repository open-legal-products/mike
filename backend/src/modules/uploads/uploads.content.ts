// Content-based validation for uploaded documents. The browser's filename and
// Content-Type are claims; the bytes are the evidence. A file is accepted only
// when its leading bytes (and, for OOXML, its package layout) match the type
// it was declared as.

import JSZip from "jszip";

/**
 * Bytes read from the start of an object for the checks that need no more: a
 * PDF header must appear within the first 1024 bytes (ISO 32000), and the OLE
 * signature is 8.
 */
export const HEAD_BYTES = 1024;

const OLE_SIGNATURE = Buffer.from([
  0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1,
]);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// The part every valid package of that type must contain, besides
// [Content_Types].xml.
const OOXML_MAIN_PART: Record<string, string> = {
  docx: "word/document.xml",
  xlsx: "xl/workbook.xml",
  xlsm: "xl/workbook.xml",
  pptx: "ppt/presentation.xml",
};

const LEGACY_OLE_TYPES = new Set(["doc", "xls", "ppt"]);

/** Whether the type is checked by reading the whole object (a ZIP package). */
export function needsFullObjectForValidation(fileType: string): boolean {
  return fileType.toLowerCase() in OOXML_MAIN_PART;
}

export function hasPdfHeader(head: Uint8Array): boolean {
  return Buffer.from(head.subarray(0, HEAD_BYTES))
    .toString("latin1")
    .includes("%PDF-");
}

async function isOoxmlPackage(
  bytes: Uint8Array,
  mainPart: string,
): Promise<boolean> {
  // Copy only the 4 signature bytes; hand JSZip the original array so a
  // 100 MB upload is not held in memory twice.
  if (!Buffer.from(bytes.subarray(0, 4)).equals(ZIP_SIGNATURE)) return false;
  try {
    // Reads only the central directory; no entry is decompressed.
    const zip = await JSZip.loadAsync(bytes);
    return zip.file("[Content_Types].xml") !== null &&
      zip.file(mainPart) !== null;
  } catch {
    return false;
  }
}

/**
 * True when `bytes` plausibly is a document of `fileType`. For PDFs only the
 * head of the object is needed; for OOXML types the whole object is. Unknown
 * types are rejected.
 */
export async function validateDocumentContent(
  fileType: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const type = fileType.toLowerCase();
  if (type === "pdf") return hasPdfHeader(bytes);
  if (LEGACY_OLE_TYPES.has(type)) {
    return Buffer.from(bytes.subarray(0, 8)).equals(OLE_SIGNATURE);
  }
  const mainPart = OOXML_MAIN_PART[type];
  if (mainPart) return await isOoxmlPackage(bytes, mainPart);
  return false;
}
