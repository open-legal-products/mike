import { describe, expect, it } from "vitest";
import { AppError } from "../../appError";
import { ConversionError } from "../../convert";
import { diagnosticErrorTags } from "../../observability/sentryPrivacy";
import {
  ExtractionParseError,
  asExtractionFailure,
  extractionFailureFromWire,
  extractionFailureToWire,
  isByteRejection,
} from "../failure";

const named = (name: string, message = "detail") => Object.assign(new Error(message), { name });
const errno = (code: string, message = `spawn soffice ${code}`) => Object.assign(new Error(message), { code });
const pdfUnreadable = (cause: unknown) => new AppError("extraction.pdf_parse_failed", "document_text_pdf_unreadable", { cause });

// A byte rejection fails the same way on every attempt, so its job stops.
// Everything else keeps the retries it had before the kind crossed IPC.
const CASES: Array<[label: string, error: unknown, rejected: boolean]> = [
  ["pdf.js: malformed PDF", pdfUnreadable(named("InvalidPDFException", "Invalid PDF structure.")), true],
  ["pdf.js: encrypted PDF", pdfUnreadable(named("PasswordException", "No password given")), true],
  ["JSZip: not a ZIP container", new Error("Can't find end of central directory : is this a zip file ?"), true],
  ["JSZip: CRC mismatch", new Error("Corrupted zip : CRC32 mismatch"), true],
  ["JSZip: truncated entry", new Error("Bug or corrupted zip : didn't get enough information from the central directory"), true],
  ["JSZip: encrypted container", new Error("Encrypted zip are not supported"), true],
  ["mammoth: no main part", new Error("Could not find main document part. Are you sure this is a valid .docx file?"), true],
  ["docx reader: no document.xml", new Error("document.xml missing from docx"), true],
  ["unsupported format verdict", new Error("document_text_unsupported_format"), true],

  ["soffice spawn ENOENT", new AppError("conversion.unavailable", "LibreOffice was not found", { cause: errno("ENOENT") }), false],
  ["soffice spawn EACCES", new AppError("conversion.unavailable", "LibreOffice was not found", { cause: errno("EACCES") }), false],
  ["no soffice on this host", new ConversionError("conversion.unavailable", "LibreOffice was not found"), false],
  ["soffice spawn EAGAIN", new ConversionError("conversion.failed", "LibreOffice conversion failed", { cause: errno("EAGAIN") }), false],
  ["soffice spawn EMFILE", new ConversionError("conversion.failed", "LibreOffice conversion failed", { cause: errno("EMFILE") }), false],
  ["soffice killed", new ConversionError("conversion.failed", "LibreOffice conversion failed", { cause: Object.assign(new Error("Command failed"), { code: null, signal: "SIGKILL" }) }), false],
  ["soffice timed out", new ConversionError("conversion.timeout", "LibreOffice conversion timed out"), false],
  ["scratch dir full", errno("ENOSPC", "ENOSPC: no space left on device, write"), false],
  ["out of file handles", errno("ENFILE"), false],
  ["broken pipe", errno("EPIPE"), false],
  ["reset connection", errno("ECONNRESET"), false],
  ["timed-out socket", errno("ETIMEDOUT"), false],
  ["Node runtime code", errno("ERR_STREAM_DESTROYED"), false],
  ["aborted call", named("AbortError", "This operation was aborted"), false],
  ["timed-out call", named("TimeoutError", "The operation timed out"), false],
  ["pdf.js could not load", pdfUnreadable(new AppError("extraction.failed", "pdf.js could not be loaded", { cause: errno("ERR_MODULE_NOT_FOUND") })), false],
  ["pdf.js crashed after opening", pdfUnreadable(new AppError("extraction.failed", "PDF text processing failed", { cause: new TypeError("x is undefined") })), false],
  ["environment wins over a rejection", pdfUnreadable(Object.assign(named("InvalidPDFException"), { cause: errno("ENOSPC") })), false],
  ["errno inside an AggregateError", new AggregateError([errno("EMFILE"), new Error("Corrupted zip : CRC32 mismatch")]), false],
  ["unattributed parser bug", new TypeError("Cannot read properties of undefined"), false],
  // What getDocument rejects with for any worker-side error it does not pass
  // through (a FormatError or XRefParseException in the worker arrives as
  // this): not attributable to the bytes, so it keeps its retries.
  ["pdf.js: unknown worker error", pdfUnreadable(named("UnknownErrorException", "Bad FCHECK in flate stream")), false],
  ["pdf_parse_failed with no recognised cause", pdfUnreadable(new Error("Setting up fake worker failed")), false],
  ["non-Error throw", "boom", false],
];

describe("isByteRejection", () => {
  it.each(CASES)("%s -> %s", (_label, error, rejected) => {
    expect(isByteRejection(error)).toBe(rejected);
  });
});

describe("extraction failures across the process boundary", () => {
  it.each(CASES)("%s crosses as the same verdict", (_label, error, rejected) => {
    const wire = extractionFailureToWire(error);
    // Exactly what IPC's advanced serialization does to it.
    const rebuilt = extractionFailureFromWire(structuredClone(wire));
    expect(rebuilt instanceof ExtractionParseError).toBe(rejected);
    expect(rebuilt).toBeInstanceOf(AppError);
    // Only allowlisted labels cross; the kind and code read the same on both sides.
    expect(Object.keys(wire).every((key) => ["message", "kind", "code", "name", "retryable", "stack", "original"].includes(key))).toBe(true);
    if (error instanceof Error) expect((rebuilt.cause as Error).stack).toBe(error.stack);
    const { error_kind: _kind, ...before } = diagnosticErrorTags(error);
    expect(diagnosticErrorTags(rebuilt)).toMatchObject(before);
  });

  it("names a retryable converter failure after its own kind and errno", () => {
    const spawnFailure = new AppError("conversion.unavailable", "LibreOffice was not found", { cause: errno("ENOENT") });
    const rebuilt = extractionFailureFromWire(structuredClone(extractionFailureToWire(spawnFailure)));
    expect(rebuilt).not.toBeInstanceOf(ExtractionParseError);
    expect(diagnosticErrorTags(rebuilt)).toEqual({ error_kind: "conversion.unavailable", failure_code: "ENOENT" });
  });

  it("classifies the in-process path the same way, keeping a retryable error as it was", () => {
    const spawnFailure = new AppError("conversion.unavailable", "LibreOffice was not found", { cause: errno("ENOENT") });
    expect(asExtractionFailure(spawnFailure)).toBe(spawnFailure);
    const corrupt = new Error("Corrupted zip : CRC32 mismatch");
    const parsed = asExtractionFailure(corrupt);
    expect(parsed).toBeInstanceOf(ExtractionParseError);
    expect((parsed as Error).cause).toBe(corrupt);
    expect(diagnosticErrorTags(parsed)).toMatchObject({ error_kind: "extraction.parse_failed" });
  });
});


it("retains retries when an older or incomplete IPC reply has no verdict", () => {
  const error = extractionFailureFromWire({ message: "unknown failure" });
  expect(error).not.toBeInstanceOf(ExtractionParseError);
  expect(error.kind).toBe("extraction.failed");
});

it("retains intermediate causes and aggregate branches without moving the leaf errno", () => {
  const leaf = errno("ENOSPC");
  leaf.stack = "Error: ENOSPC\n    at write (backend/src/lib/extraction/scratch.ts:12:3)";
  const middle = new TypeError("parser failed", { cause: leaf });
  const original = new AppError("extraction.failed", "cannot extract", { cause: new AggregateError([middle, new Error("other")], "aggregate") });
  const rebuilt = extractionFailureFromWire(structuredClone(extractionFailureToWire(original)));
  const root = rebuilt.cause as AppError;
  expect(root.kind).toBe("extraction.failed");
  expect(root).not.toHaveProperty("code");
  const aggregate = root.cause as AggregateError;
  expect(aggregate.name).toBe("AggregateError");
  expect(aggregate.errors).toHaveLength(2);
  expect(aggregate.errors[0]).toMatchObject({ name: "TypeError", message: "parser failed", cause: { code: "ENOSPC", stack: leaf.stack } });
});

it("bounds cycles, cause depth, aggregate width and local strings", () => {
  const cyclic = new Error("x".repeat(5000));
  cyclic.cause = cyclic;
  const wire = extractionFailureToWire(new AggregateError(Array.from({ length: 20 }, () => cyclic)));
  expect(wire.original?.errors).toHaveLength(1);
  expect(wire.original?.errors?.[0]?.message).toHaveLength(4096);
  expect(wire.original?.errors?.[0]?.cause).toBeUndefined();
  let deep: Error = new Error("leaf");
  for (let i = 0; i < 50; i++) deep = new Error("wrapper", { cause: deep });
  let link = extractionFailureToWire(deep).original;
  let depth = 0;
  while (link) { depth++; link = link.cause; }
  expect(depth).toBe(8);
});
