import type { Response } from "express";
import { docxToPdf } from "./convert";
import {
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "./documentTypes";
import { buildContentDisposition, downloadFile, downloadFileIfAvailable } from "./storage";

export interface DocumentDisplaySource {
  filename: string;
  fileType?: string | null;
  storagePath: string;
  pdfStoragePath?: string | null;
}

export interface DocumentDisplayPayload {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

function normalizedFileType(source: {
  filename: string;
  fileType?: string | null;
}): string {
  return (
    source.fileType?.trim().toLowerCase() ||
    source.filename.split(".").pop()?.toLowerCase() ||
    ""
  );
}

function toBuffer(bytes: ArrayBuffer | ArrayBufferView): Buffer {
  return ArrayBuffer.isView(bytes)
    ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : Buffer.from(bytes);
}

export async function prepareDocumentDisplay(source: {
  filename: string;
  fileType?: string | null;
  sourceBytes: ArrayBuffer | ArrayBufferView;
}): Promise<DocumentDisplayPayload> {
  const fileType = normalizedFileType(source);
  if (shouldConvertToPdf(fileType)) {
    return {
      bytes: await docxToPdf(toBuffer(source.sourceBytes)),
      contentType: "application/pdf",
      filename: pdfFilename(source.filename),
    };
  }
  return {
    bytes: toBuffer(source.sourceBytes),
    contentType: contentTypeForDocumentType(fileType),
    filename: source.filename,
  };
}

function pdfFilename(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, "");
  return `${stem || filename}.pdf`;
}

/**
 * Resolve the bytes and response metadata used by every document-like preview.
 * Word and presentation files always become PDF, using a stored rendition when
 * available and LibreOffice as the fallback. PDFs and spreadsheets are served
 * unchanged.
 */
export async function loadDocumentDisplay(
  source: DocumentDisplaySource,
): Promise<DocumentDisplayPayload | null> {
  const fileType = normalizedFileType(source);
  const convertToPdf = shouldConvertToPdf(fileType);

  if (convertToPdf) {
    if (source.pdfStoragePath) {
      const pdfBytes = await downloadFileIfAvailable(source.pdfStoragePath);
      if (pdfBytes) {
        return {
          bytes: Buffer.from(pdfBytes),
          contentType: "application/pdf",
          filename: pdfFilename(source.filename),
        };
      }
    }
    const sourceBytes = await downloadFile(source.storagePath);
    if (!sourceBytes) return null;
    return prepareDocumentDisplay({
      filename: source.filename,
      fileType,
      sourceBytes,
    });
  }

  const storedBytes = await downloadFile(source.storagePath);
  if (!storedBytes) return null;
  return prepareDocumentDisplay({
    filename: source.filename,
    fileType,
    sourceBytes: storedBytes,
  });
}

export function sendDocumentDisplay(
  res: Response,
  payload: DocumentDisplayPayload,
): void {
  res.setHeader("Content-Type", payload.contentType);
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition("inline", payload.filename),
  );
  res.send(payload.bytes);
}
