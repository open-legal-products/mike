import type { Response } from "express";
import { docxToPdf } from "./convert";
import {
  contentTypeForDocumentType,
  isVisualDocumentType,
  shouldConvertToPdf,
} from "./documentTypes";
import {
  buildContentDisposition,
  downloadFile,
} from "./storage";
import { composeStoredVisual } from "./visuals/compose";

/**
 * Model-written HTML must never render on the API origin, where it would run
 * with the caller's cookies: it is sent as a download, in a sandbox.
 */
const VISUAL_RESPONSE_CSP = "sandbox; default-src 'none'";

export function setVisualResponseHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", VISUAL_RESPONSE_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
}

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
  if (isVisualDocumentType(fileType)) {
    return {
      bytes: Buffer.from(await composeStoredVisual(toBuffer(source.sourceBytes)), "utf8"),
      contentType: contentTypeForDocumentType(fileType),
      filename: source.filename,
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
      const pdfBytes = await downloadFile(source.pdfStoragePath);
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
  const isHtml = payload.contentType.startsWith("text/html");
  if (isHtml) setVisualResponseHeaders(res);
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(isHtml ? "attachment" : "inline", payload.filename),
  );
  res.send(payload.bytes);
}
