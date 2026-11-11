import { normalizeDownloadFilename } from "./storage";

export const MAX_ZIP_EXPORT_DOCUMENTS = 200;
export const MAX_ZIP_EXPORT_BYTES = 2 * 1024 * 1024 * 1024;

export function zipExportLimitDetail(
  documentCount: number,
  totalBytes: number,
): string | null {
  if (documentCount > MAX_ZIP_EXPORT_DOCUMENTS) {
    return `A ZIP download can include at most ${MAX_ZIP_EXPORT_DOCUMENTS} documents.`;
  }
  if (totalBytes > MAX_ZIP_EXPORT_BYTES) {
    return "A ZIP download can include at most 2 GB of source files.";
  }
  return null;
}

// Default macOS (APFS) and Windows (NTFS) disks treat "Agreement.pdf" and
// "agreement.pdf" as one file, and APFS also equates the composed and
// decomposed spellings of "Résumé.pdf", so extracting both keeps only one.
// `usedNames` holds these folded keys, while the entry keeps the document's
// own spelling. NFC, not NFKC: neither disk equates compatibility forms such
// as "ﬁ" and "fi".
function archiveNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

export function uniqueArchiveFilename(
  requestedName: string,
  usedNames: Set<string>,
): string {
  // Callers supply document leaf names. Match individual downloads before
  // reserving names, so renamed separators cannot become ZIP path aliases.
  // JSZip also resolves bare dot segments to the empty path when reopening.
  const filename = normalizeDownloadFilename(requestedName).replace(/^\.{1,2}$/, "_");
  const key = archiveNameKey(filename);
  if (!usedNames.has(key)) {
    usedNames.add(key);
    return filename;
  }

  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  let copyNumber = 2;
  let candidate = `${stem} (${copyNumber})${extension}`;
  while (usedNames.has(archiveNameKey(candidate))) {
    copyNumber += 1;
    candidate = `${stem} (${copyNumber})${extension}`;
  }
  usedNames.add(archiveNameKey(candidate));
  return candidate;
}
