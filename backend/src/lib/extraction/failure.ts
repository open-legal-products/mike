// A parser's failure has to cross the process boundary as plain data. Only
// its diagnostic labels travel: the developer-authored kind and an
// allowlisted technical code, read the same way the Sentry boundary reads
// them. The message stays on the error for local logs and job rows only.
import { AppError } from "../appError";
import { diagnosticErrorTags } from "../observability/sentryPrivacy";

/**
 * The parser ran and rejected these bytes (corrupt, encrypted, unsupported
 * format). The same bytes fail the same way on every attempt, so a job that
 * sees this should stop instead of spending its retry budget.
 */
export class ExtractionParseError extends AppError {}

/** The structured-clone-safe shape of a parser failure. */
export type ParseFailureWire = { message: string; kind?: string; code?: string; name?: string };

const DEFAULT_KIND = "extraction.parse_failed";
// An exception class name such as TypeError or InvalidPDFException.
const ERROR_NAME = /^[A-Z][A-Za-z0-9]{0,63}$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "document extraction failed";
}

/** Child side: describe a parser failure for the IPC reply. */
export function parseFailureToWire(error: unknown): ParseFailureWire {
  const tags = diagnosticErrorTags(error);
  const name = error instanceof Error ? error.name : undefined;
  return {
    message: messageOf(error),
    ...(typeof tags.error_kind === "string" ? { kind: tags.error_kind } : {}),
    ...(typeof tags.failure_code === "string" ? { code: tags.failure_code } : {}),
    ...(name && ERROR_NAME.test(name) ? { name } : {}),
  };
}

/** Parent side: rebuild the typed error the parser threw in the child. */
export function parseFailureFromWire(wire: ParseFailureWire): ExtractionParseError {
  // The child's own error, minus its stack: name and code sit on the cause
  // where they sat in the child, so failure_code is read the same way.
  const original = Object.assign(new Error(wire.message), wire.code ? { code: wire.code } : {});
  if (wire.name && ERROR_NAME.test(wire.name)) original.name = wire.name;
  return new ExtractionParseError(wire.kind ?? DEFAULT_KIND, wire.message, { cause: original });
}

/** In-process parsing (EXTRACTION_ISOLATION=off): the same type, original kept as cause. */
export function asParseFailure(error: unknown): ExtractionParseError {
  if (error instanceof ExtractionParseError) return error;
  const kind = diagnosticErrorTags(error).error_kind;
  return new ExtractionParseError(typeof kind === "string" ? kind : DEFAULT_KIND, messageOf(error), { cause: error });
}
