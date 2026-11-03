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

export function uniqueArchiveFilename(
  requestedName: string,
  usedNames: Set<string>,
): string {
  // Callers supply document leaf names. Match individual downloads before
  // reserving names, so renamed separators cannot become ZIP path aliases.
  const filename = normalizeDownloadFilename(requestedName);
  if (!usedNames.has(filename)) {
    usedNames.add(filename);
    return filename;
  }

  const dot = filename.lastIndexOf(".");
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const extension = dot > 0 ? filename.slice(dot) : "";
  let copyNumber = 2;
  let candidate = `${stem} (${copyNumber})${extension}`;
  while (usedNames.has(candidate)) {
    copyNumber += 1;
    candidate = `${stem} (${copyNumber})${extension}`;
  }
  usedNames.add(candidate);
  return candidate;
}
