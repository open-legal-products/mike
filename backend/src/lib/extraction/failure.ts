// Extraction failures cross local IPC with source stacks and fixed diagnostic
// labels. Messages and stacks remain local until the final outbound privacy
// boundary reconstructs safe fields. Proven invalid bytes stop retries.
import { AppError } from "../appError";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";

/**
 * The parser ran and rejected these bytes (corrupt, encrypted, unsupported
 * format). The same bytes fail the same way on every attempt, so a job that
 * sees this should stop instead of spending its retry budget.
 */
export class ExtractionParseError extends AppError {}

/** The structured-clone-safe shape of an extraction failure. */
export type ExtractionFailureWire = {
  message: string;
  /** Local IPC only; the outbound privacy boundary reconstructs safe frames. */
  stack?: string;
  kind?: string;
  code?: string;
  name?: string;
  /** The child could not attribute the failure to the bytes (see isByteRejection). */
  retryable?: boolean;
  /** Bounded original cause tree, local IPC only. */
  original?: ExtractionErrorWire;
};

type ExtractionErrorWire = {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
  kind?: string;
  status?: number;
  statusCode?: number;
  cause?: ExtractionErrorWire;
  errors?: ExtractionErrorWire[];
};

const PARSE_KIND = "extraction.parse_failed";
const RETRYABLE_KIND = "extraction.failed";
// An exception class name such as TypeError or InvalidPDFException.
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

// The environment failed, whatever the bytes were: an errno or Node/undici
// runtime code (spawn ENOENT/EAGAIN/EMFILE, ENOSPC on the scratch dir), an
// aborted or timed-out call, or a step this process does not own (the
// LibreOffice conversion, a pdf.js that could not load or crashed after it
// opened the file). Any of these anywhere on the chain wins.
const SYSTEM_CODE = /^(?:E[A-Z0-9]{2,}|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/;
const RUNTIME_NAMES = new Set(["AbortError", "TimeoutError"]);
const ENVIRONMENT_KIND = /^(?:conversion\.|extraction\.failed$)/;

// A parser's own verdict on the bytes: pdf.js's rejection classes, a ZIP
// container (docx/pptx/xlsx) JSZip cannot read, an OOXML package missing its
// main part, and the verdicts our parsers throw deliberately.
//
// Only the classes pdf.js's getDocument can actually surface: its message
// handler (wrapReason in pdfjs-dist's pdf.mjs) passes InvalidPDFException and
// PasswordException through and turns every other worker-side error —
// FormatError, XRefParseException included — into UnknownErrorException,
// which is not attributable to the bytes and keeps its retries.
const PARSER_REJECTION_NAMES = new Set(["InvalidPDFException", "PasswordException"]);
const PARSER_REJECTION_MESSAGE = new RegExp([
  "^Can't find end of central directory",
  "^(?:Bug or )?[Cc]orrupted zip",
  "^End of data reached",
  "^Encrypted zip are not supported",
  "^Multi-volumes zip are not supported",
  "^Could not find main document part",
  "^document\\.xml missing from docx$",
  "^w:body missing from document\\.xml$",
  "^document_text_unsupported_format$",
].join("|"));

/** The error and its causes, breadth-first, as diagnosticErrorTags walks them. */
function chainOf(error: unknown): Array<Record<string, unknown>> {
  const links: Array<Record<string, unknown>> = [];
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length && links.length < 12) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const link = item as Record<string, unknown>;
    links.push(link);
    if (link.cause) pending.push(link.cause);
    if (Array.isArray(link.errors)) pending.push(...link.errors.slice(0, 5));
  }
  return links;
}

/**
 * True only when a parser rejected the bytes themselves, so a retry would
 * read the same bytes and fail the same way. An environment failure, or
 * anything this cannot attribute to the bytes, is false: it keeps its retries.
 */
export function isByteRejection(error: unknown): boolean {
  const links = chainOf(error);
  const environment = links.some((link) =>
    (typeof link.code === "string" && SYSTEM_CODE.test(link.code))
    || (typeof link.name === "string" && RUNTIME_NAMES.has(link.name))
    || (link instanceof AppError && ENVIRONMENT_KIND.test(link.kind)));
  if (environment) return false;
  return links.some((link) =>
    (typeof link.name === "string" && PARSER_REJECTION_NAMES.has(link.name))
    || (typeof link.message === "string" && PARSER_REJECTION_MESSAGE.test(link.message)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "document extraction failed";
}

/** Keep local causes without serializing arbitrary parser fields or cycles. */
function originalToWire(error: unknown): ExtractionErrorWire | undefined {
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): ExtractionErrorWire | undefined => {
    if (!value || typeof value !== "object" || seen.has(value) || seen.size >= 12 || depth >= 8) return undefined;
    seen.add(value);
    const source = value as Record<string, unknown>;
    const wire: ExtractionErrorWire = {
      message: typeof source.message === "string" ? source.message.slice(0, 4096) : "document extraction failed",
      ...(typeof source.name === "string" && ERROR_NAME.test(source.name) ? { name: source.name } : {}),
      ...(typeof source.stack === "string" ? { stack: source.stack.slice(0, 32768) } : {}),
      ...(typeof source.code === "string" ? { code: source.code.slice(0, 128) } : {}),
      ...(value instanceof AppError ? { kind: value.kind } : {}),
      ...(typeof source.status === "number" ? { status: source.status } : {}),
      ...(typeof source.statusCode === "number" ? { statusCode: source.statusCode } : {}),
    };
    const cause = visit(source.cause, depth + 1);
    if (cause) wire.cause = cause;
    if (Array.isArray(source.errors)) {
      const errors = source.errors.slice(0, 5).flatMap((item) => {
        const child = visit(item, depth + 1);
        return child ? [child] : [];
      });
      if (errors.length) wire.errors = errors;
    }
    return wire;
  };
  return visit(error, 0);
}

function originalFromWire(wire: ExtractionErrorWire): Error {
  const cause = wire.cause ? originalFromWire(wire.cause) : undefined;
  const original = wire.kind
    ? new AppError(wire.kind, wire.message, { cause })
    : new Error(wire.message, cause ? { cause } : undefined);
  if (wire.name && ERROR_NAME.test(wire.name)) original.name = wire.name;
  if (wire.stack) original.stack = wire.stack;
  if (wire.code) Object.assign(original, { code: wire.code });
  if (wire.status !== undefined) Object.assign(original, { status: wire.status });
  if (wire.statusCode !== undefined) Object.assign(original, { statusCode: wire.statusCode });
  if (wire.errors) Object.assign(original, { errors: wire.errors.map(originalFromWire) });
  return original;
}

/** Child side: describe an extraction failure for the IPC reply. */
export function extractionFailureToWire(error: unknown): ExtractionFailureWire {
  const tags = diagnosticErrorTags(error);
  const name = error instanceof Error ? error.name : undefined;
  return {
    message: messageOf(error).slice(0, 4096),
    ...(error instanceof Error && error.stack ? { stack: error.stack.slice(0, 32768) } : {}),
    ...(typeof tags.error_kind === "string" ? { kind: tags.error_kind } : {}),
    ...(typeof tags.failure_code === "string" ? { code: tags.failure_code } : {}),
    ...(name && ERROR_NAME.test(name) ? { name } : {}),
    retryable: !isByteRejection(error),
    original: originalToWire(error),
  };
}

/**
 * Parent side: only an explicit byte-rejection verdict stops retries. An older
 * child or an incomplete reply must not turn an unknown failure into bad bytes.
 */
export function extractionFailureFromWire(wire: ExtractionFailureWire): AppError {
  const original = wire.original ? originalFromWire(wire.original) : originalFromWire(wire);
  return wire.retryable === false
    ? new ExtractionParseError(wire.kind ?? PARSE_KIND, wire.message, { cause: original })
    : new AppError(wire.kind ?? RETRYABLE_KIND, wire.message, { cause: original });
}

/**
 * In-process parsing (EXTRACTION_ISOLATION=off): the same classification. A
 * byte rejection becomes ExtractionParseError with the original as cause;
 * anything else is rethrown as it was.
 */
export function asExtractionFailure(error: unknown): unknown {
  if (error instanceof ExtractionParseError || !isByteRejection(error)) return error;
  const kind = diagnosticErrorTags(error).error_kind;
  return new ExtractionParseError(typeof kind === "string" ? kind : PARSE_KIND, messageOf(error), { cause: error });
}
