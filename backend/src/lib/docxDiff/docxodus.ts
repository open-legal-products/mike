// Docxodus (MIT) comparison engine: a .NET OOXML engine compiled to
// WebAssembly and run in-process. `docxodus/core` is the UI-free entry point
// and is ESM-only, so it is loaded with a dynamic import on first use; a
// process that never compares documents never loads the ~13 MB runtime.

import {
  DocxDiffError,
  summarizeDocxDiff,
  type DocxDiffEngine,
  type DocxDiffRevision,
  type DocxDiffRevisionKind,
} from "./types";

// The package is ESM-only and this file compiles to CommonJS, so the type
// import states its resolution mode; the runtime import below is dynamic.
type DocxodusCore = typeof import("docxodus/core", { with: { "resolution-mode": "import" } });

let runtime: Promise<DocxodusCore> | null = null;

function loadRuntime(): Promise<DocxodusCore> {
  runtime ??= (async () => {
    const core = await import("docxodus/core");
    await core.initialize();
    return core;
  })().catch((error: unknown) => {
    // A failed start (missing package files, out of memory) must not poison
    // every later comparison in this process.
    runtime = null;
    throw error;
  });
  return runtime;
}

const KINDS: ReadonlySet<string> = new Set<DocxDiffRevisionKind>([
  "insert", "delete", "move", "format", "structure",
]);

export const docxodusDiffEngine: DocxDiffEngine = {
  id: "docxodus",
  async compare(original, revised, { author, date }) {
    const core = await loadRuntime();
    let redline: Uint8Array;
    let listed: Awaited<ReturnType<DocxodusCore["getRevisions"]>>;
    try {
      redline = await core.docxDiffCompare(new Uint8Array(original), new Uint8Array(revised), {
        authorForRevisions: author,
        // Whole seconds, the form Word itself writes in w:date.
        dateTimeForRevisions: date.toISOString().replace(/\.\d{3}Z$/, "Z"),
        preAcceptInputRevisions: true,
      });
      listed = await core.getRevisions(redline);
    } catch (error) {
      throw new DocxDiffError("The documents could not be compared.", { cause: error });
    }
    const revisions: DocxDiffRevision[] = listed.map((revision) => ({
      // A kind this build does not know is still a difference worth listing.
      kind: KINDS.has(revision.type) ? (revision.type as DocxDiffRevisionKind) : "structure",
      text: revision.text ?? "",
      wordIds: revision.constituentIds ?? [],
    }));
    return { redline: Buffer.from(redline), revisions, summary: summarizeDocxDiff(revisions) };
  },
};
