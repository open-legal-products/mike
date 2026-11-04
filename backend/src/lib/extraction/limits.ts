/** Limits are deliberately independent of parsers and queue transports. */
export const EXTRACTION_MAX_BYTES = 150 * 1024 * 1024;
export const EXTRACTION_MAX_TEXT_BYTES = 16 * 1024 * 1024;

export const SPREADSHEET_VALUES_MAX_BYTES = 5 * 1024 * 1024;
export const SPREADSHEET_VALUES_LIMITS = Object.freeze({
  inputBytes: SPREADSHEET_VALUES_MAX_BYTES, sheets: 8, rows: 200, columns: 50,
  cells: 5000, renderedCells: 5000, textBytes: 512, outputBytes: 1024 * 1024,
});
const SPREADSHEET_VALUES_MESSAGES = {
  spreadsheet_values_unsupported: "Only unencrypted BIFF8 .xls worksheets are supported for values preview.",
  spreadsheet_values_encrypted: "Encrypted workbooks cannot be previewed. Download the original.",
  spreadsheet_values_malformed: "This workbook could not be interpreted safely.",
  spreadsheet_values_limit: "This workbook exceeds the values-preview limits. Download the original.",
  spreadsheet_values_unavailable: "Spreadsheet values preview requires an available isolated parser.",
} as const;
export type SpreadsheetValuesErrorCode = keyof typeof SPREADSHEET_VALUES_MESSAGES;
export function isSpreadsheetValuesErrorCode(code: unknown): code is SpreadsheetValuesErrorCode {
  return typeof code === "string" && Object.hasOwn(SPREADSHEET_VALUES_MESSAGES, code);
}
/** Error messages are source-authored; parser diagnostics never cross IPC. */
export class SpreadsheetValuesError extends Error {
  constructor(readonly code: SpreadsheetValuesErrorCode) {
    super(SPREADSHEET_VALUES_MESSAGES[code]);
    this.name = "SpreadsheetValuesError";
  }
}

export function spreadsheetValuesFailureReply(error: unknown): {
  ok: false; limited: boolean; code: SpreadsheetValuesErrorCode; message: string;
} {
  const code = error instanceof SpreadsheetValuesError && isSpreadsheetValuesErrorCode(error.code) ? error.code :
    error instanceof ExtractionLimitError || isAllocationFailure(error) ? "spreadsheet_values_limit" : "spreadsheet_values_malformed";
  const safe = new SpreadsheetValuesError(code);
  return { ok: false, limited: code === "spreadsheet_values_limit", code, message: safe.message };
}

/** New structured output needs a full payload budget, not the text-only one. */
export function assertSpreadsheetValuesOutputBudget(result: unknown): void {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(result); }
  catch { throw new SpreadsheetValuesError("spreadsheet_values_malformed"); }
  if (serialized === undefined) throw new SpreadsheetValuesError("spreadsheet_values_malformed");
  if (Buffer.byteLength(serialized, "utf8") > SPREADSHEET_VALUES_LIMITS.outputBytes) {
    throw new SpreadsheetValuesError("spreadsheet_values_limit");
  }
}

function positiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

// A DB claim becomes stale after ten minutes. Reserve time for I/O too.
export const extractionTimeoutMs = () => Math.min(positiveNumber("EXTRACTION_TIMEOUT_MS", 180_000), 300_000);
export const extractionMemoryMb = () => Math.min(65_536, Math.max(1, Math.floor(positiveNumber("EXTRACTION_MAX_MEMORY_MB", 1024))));

export class ExtractionLimitError extends Error {
  constructor(reason: string) {
    super(`document_too_large: ${reason}`);
    this.name = "ExtractionLimitError";
  }
}

/** Capacity is transient: never classify it as a document-size failure. */
export class ExtractionBusyError extends Error {
  constructor() {
    super("document_extraction_busy");
    this.name = "ExtractionBusyError";
  }
}

export function isAllocationFailure(error: unknown): boolean {
  return error instanceof Error && /array buffer allocation failed|invalid array buffer length|invalid string length|out of memory|\bENOMEM\b/i.test(error.message);
}
