import { copyFile, downloadFile, uploadFile } from "../../lib/storage";
import { contentTypeForDocumentType } from "../../lib/documentTypes";

type CopySource = {
  storage_path: string;
  pdf_storage_path?: string | null;
  file_type?: string | null;
};

/**
 * Copy an already-authorized version into fresh, caller-owned object keys.
 * Callers retain scope checks and metadata policy. Required renditions (batch
 * workflow assets) fail the copy; optional renditions (project/version copies)
 * preserve the source file when a legacy PDF object is missing.
 */
export async function copyDocumentVersionFiles(args: {
  source: CopySource;
  storagePath: string;
  pdfStoragePath: string;
  transport: "server" | "download";
  rendition: "required" | "optional";
  sourceBytes?: ArrayBuffer;
  beforeWrite?: (key: string) => void;
}): Promise<{ pdfStoragePath: string | null }> {
  const transfer = async (
    from: string,
    to: string,
    contentType: string,
    bytes?: ArrayBuffer,
  ) => {
    args.beforeWrite?.(to);
    if (args.transport === "server") return copyFile(from, to);
    const body = bytes ?? (await downloadFile(from));
    if (!body) throw new Error("copy_source_unavailable");
    await uploadFile(to, body, contentType);
  };
  await transfer(
    args.source.storage_path,
    args.storagePath,
    contentTypeForDocumentType(args.source.file_type ?? ""),
    args.sourceBytes,
  );
  const pdf = args.source.pdf_storage_path;
  if (!pdf) return { pdfStoragePath: null };
  if (pdf === args.source.storage_path)
    return { pdfStoragePath: args.storagePath };
  if (args.transport === "download" && args.rendition === "optional") {
    const bytes = await downloadFile(pdf);
    if (!bytes) return { pdfStoragePath: null };
    await transfer(pdf, args.pdfStoragePath, "application/pdf", bytes);
  } else {
    await transfer(pdf, args.pdfStoragePath, "application/pdf");
  }
  return { pdfStoragePath: args.pdfStoragePath };
}
