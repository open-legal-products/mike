// Minimal typed facade over the slice of `pdfjs-dist` we actually use.
//
// We import the library's legacy ESM build via a dynamic `import()` whose
// specifier is cast to `string` so it resolves at runtime (the legacy build
// ships no usable type declarations). Rather than repeat an
// `as unknown as { getDocument: ... }` shape at every call site, we declare
// the surface once here and load through `loadPdfjs()`.

export interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export interface PdfTextContent {
  items: PdfTextItem[];
}

export interface PdfPage {
  getTextContent(): Promise<PdfTextContent>;
}

export interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}

export interface PdfDocumentTask {
  promise: Promise<PdfDocument>;
}

export interface PdfjsLib {
  getDocument(opts: {
    data: Uint8Array;
    standardFontDataUrl?: string;
  }): PdfDocumentTask;
}

/**
 * Load the pdfjs legacy build, typed as the {@link PdfjsLib} facade.
 *
 * The specifier is cast to `string` so TypeScript treats it as a dynamic
 * runtime import (the legacy `.mjs` build has no bundled types); the awaited
 * module is therefore `any`, which we narrow to the facade here in one place.
 */
export async function loadPdfjs(): Promise<PdfjsLib> {
  const mod = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  return mod as PdfjsLib;
}
