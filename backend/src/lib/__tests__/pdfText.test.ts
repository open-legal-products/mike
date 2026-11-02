import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reportError: vi.fn() }));
vi.mock("../observability/sentry", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../observability/sentry")>();
  mocks.reportError.mockImplementation(actual.reportError);
  return { ...actual, reportError: mocks.reportError };
});

import { diagnosticErrorTags } from "../observability/sentryPrivacy";
import {
  countPagesWithoutText,
  extractPdfText,
  extractPdfTextForIndex,
  extractPdfTextForModel,
} from "../pdfText";

beforeEach(() => {
  mocks.reportError.mockClear();
});

/** Bytes pdf.js refuses: no header, no xref, nothing to rebuild. */
function notAPdf(): ArrayBuffer {
  return new TextEncoder().encode("PRIVATE_NAME.docx is not a PDF").buffer as ArrayBuffer;
}

/** A one-page PDF reading "Hello reference"; pdf.js rebuilds its xref. */
function tinyPdf(): ArrayBuffer {
  const stream = "BT /F1 12 Tf 20 100 Td (Hello reference) Tj ET";
  const source = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${stream.length} >> stream`,
    stream,
    "endstream endobj",
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return new TextEncoder().encode(source).buffer as ArrayBuffer;
}

describe("PDF text extraction", () => {
  it.each([
    ["for the model", extractPdfTextForModel],
    ["as plain text", extractPdfText],
  ])("reads the text %s without emptying the caller's bytes", async (_label, extract) => {
    const bytes = tinyPdf();
    const size = bytes.byteLength;
    expect(await extract(bytes)).toContain("Hello reference");
    // pdf.js detaches a buffer it is handed; callers still need theirs,
    // for example to store a playbook reference once its text is read.
    expect(bytes.byteLength).toBe(size);
    expect(new Uint8Array(bytes)[0]).toBe("%".charCodeAt(0));
  });
});

// A PDF pdf.js cannot open used to come back as a blank one: the parse error
// was caught, null returned, and nothing anywhere said why. The lenient
// readers keep their contract (empty string / null) and file ONE warning
// naming the kind; the strict index reader throws the same kind for its job
// runner to report.
describe("unreadable PDF", () => {
  it.each([
    ["for the model", extractPdfTextForModel, ""],
    ["as plain text", extractPdfText, ""],
    ["page count", countPagesWithoutText, null],
  ])("%s: keeps the lenient contract and logs, without reporting, the user's unreadable file", async (_label, read, expected) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await read(notAPdf())).toBe(expected);

    // An unreadable PDF is the user's file, not a fault: the strict index
    // path throws once per document (its job reports that); every lenient
    // read of the same file only logs, so one bad upload is one event.
    expect(mocks.reportError).not.toHaveBeenCalled();
    // pdf.js prints its own warnings for a malformed file; ours is the one
    // line that carries the kind.
    const ours = log.mock.calls.filter(([message]) => String(message).startsWith("[pdf-text]"));
    expect(ours).toHaveLength(1);
    const [, logged] = ours[0]! as [string, { error: unknown }];
    expect(diagnosticErrorTags(logged.error)).toEqual({
      error_kind: "extraction.pdf_parse_failed",
    });
    expect((logged.error as Error).cause).toBeInstanceOf(Error);
    log.mockRestore();
  });

  it("throws the same kind from the strict index reader instead of reporting", async () => {
    const thrown = await extractPdfTextForIndex(notAPdf()).catch(
      (error: unknown) => error,
    );

    expect(thrown).toMatchObject({ message: "document_text_pdf_unreadable" });
    expect(diagnosticErrorTags(thrown)).toEqual({
      error_kind: "extraction.pdf_parse_failed",
    });
    expect((thrown as Error).cause).toBeInstanceOf(Error);
    expect(mocks.reportError).not.toHaveBeenCalled();
  });

  it("reports nothing for a PDF it can read", async () => {
    await extractPdfText(tinyPdf());
    expect(mocks.reportError).not.toHaveBeenCalled();
  });
});
