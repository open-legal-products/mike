import { describe, expect, it } from "vitest";

import { resolveDocumentViewType } from "./documentViewType";

describe("resolveDocumentViewType", () => {
  it.each([
    ["contract.docx", null, "docx"],
    ["contract.doc", null, "pdf"],
    ["model.xlsx", null, "spreadsheet"],
    ["model.xlsm", null, "spreadsheet"],
    ["model.xls", null, "spreadsheet"],
    ["filing.pdf", null, "pdf"],
    ["notes.md", null, "text"],
    ["REPORT.TXT", null, "text"],
    [null, "text/plain", "text"],
    [null, "text/markdown", "text"],
    ["deck.pptx", null, "pdf"],
    ["unknown.bin", null, "pdf"],
    [null, "spreadsheet", "spreadsheet"],
    [null, "application/vnd.ms-excel", "spreadsheet"],
    [null, "application/msword", "pdf"],
    [
      null,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "docx",
    ],
    [
      null,
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "pdf",
    ],
    [null, "application/pdf", "pdf"],
  ] as const)(
    "resolves filename %s and file type %s to %s",
    (filename, fileType, expected) => {
      expect(resolveDocumentViewType({ filename, fileType })).toBe(expected);
    },
  );

  it("allows a caller to override the legacy Word viewer", () => {
    expect(
      resolveDocumentViewType({
        filename: "contract.doc",
        legacyDocViewType: "docx",
      }),
    ).toBe("docx");
  });

  it("prefers an available PDF rendition for Word documents", () => {
    expect(
      resolveDocumentViewType({
        filename: "contract.docx",
        preferPdfForWord: true,
      }),
    ).toBe("pdf");
  });

  it("keeps spreadsheets in the spreadsheet viewer when a PDF rendition exists", () => {
    expect(
      resolveDocumentViewType({
        filename: "model.xlsx",
        preferPdfForWord: true,
      }),
    ).toBe("spreadsheet");
  });
});
