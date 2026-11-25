export interface DocxDiffOptions {
  author: string;
  date: Date;
}

export interface DocxDiffEngine {
  readonly id: string;
  /** Per-version limit used when reading inputs for this engine. */
  readonly maxInputBytes: number;
  /** Return a redline of the accepted input versions with native tracked changes. */
  compare(original: Buffer, revised: Buffer, options: DocxDiffOptions): Promise<Buffer>;
}

export class DocxDiffError extends Error {}
