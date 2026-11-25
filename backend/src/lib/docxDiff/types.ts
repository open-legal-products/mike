// The contract a Word-document comparison engine implements. Callers get an
// engine from `getDocxDiffEngine()` (./index.ts) and never import one directly,
// so the engine can be replaced without touching the documents module.

export type DocxDiffRevisionKind = "insert" | "delete" | "move" | "format" | "structure";

/** One tracked change in the redline, in document order. */
export interface DocxDiffRevision {
  kind: DocxDiffRevisionKind;
  /** The changed text; empty for a pure formatting or structural change. */
  text: string;
  /**
   * The OOXML `w:id`s of the markup that carries this change in the redline,
   * which is what a DOCX viewer uses to reveal it.
   */
  wordIds: string[];
}

export interface DocxDiffSummary {
  insertions: number;
  deletions: number;
  moves: number;
  formatChanges: number;
  /** Table, list and other structural changes. */
  structuralChanges: number;
  total: number;
}

export interface DocxDiffResult {
  /**
   * A .docx holding the revised document with every difference from the
   * original as a native tracked change. Accepting all changes yields the
   * revised text; rejecting all yields the original.
   */
  redline: Buffer;
  revisions: DocxDiffRevision[];
  summary: DocxDiffSummary;
}

export interface DocxDiffOptions {
  /** Author stamped on the redline's tracked changes. */
  author: string;
  /** Date stamped on the redline's tracked changes. */
  date: Date;
}

export interface DocxDiffEngine {
  readonly id: string;
  /**
   * Compare two .docx files. Tracked changes already pending in either input
   * are accepted first, as Word's own Compare does, so the redline shows only
   * how the two documents differ.
   *
   * Throws `DocxDiffError` when an input cannot be read as a Word document.
   */
  compare(original: Buffer, revised: Buffer, options: DocxDiffOptions): Promise<DocxDiffResult>;
}

/** An input could not be compared (not a Word document, or the engine rejected it). */
export class DocxDiffError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DocxDiffError";
  }
}

export function summarizeDocxDiff(revisions: readonly DocxDiffRevision[]): DocxDiffSummary {
  const count = (kind: DocxDiffRevisionKind) =>
    revisions.filter((revision) => revision.kind === kind).length;
  return {
    insertions: count("insert"),
    deletions: count("delete"),
    moves: count("move"),
    formatChanges: count("format"),
    structuralChanges: count("structure"),
    total: revisions.length,
  };
}
