/** Limits are deliberately independent of parsers and queue transports. */
export const EXTRACTION_MAX_BYTES = 150 * 1024 * 1024;
export const EXTRACTION_MAX_TEXT_BYTES = 16 * 1024 * 1024;

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
